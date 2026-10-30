/**
 * Markdown for chat messages: `marked` (GFM) → DOMPurify. Code blocks render as
 * plain text first; `highlightMarkdown` re-renders them with shiki, which is
 * loaded on first use (JavaScript regex engine, no WASM) with each language
 * fetched on demand. Huge blocks are never highlighted.
 */
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import type { HighlighterCore } from 'shiki/core';

/** Blocks longer than this stay plain text (highlighting them would stall the UI). */
export const HIGHLIGHT_MAX_LINES = 2000;
const CACHE_SIZE = 400;

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`,
  );

/** First word of a fence's info string ("ts title=x" → "ts"). */
const langOf = (info: string | undefined): string => (info ?? '').trim().split(/\s+/)[0] ?? '';

/** FNV-1a; with the length it keys caches without holding whole messages twice. */
export const hashText = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length.toString(36)}.${(h >>> 0).toString(36)}`;
};

/** Highlighted code per (lang, code) for the parse in progress (parsing is synchronous). */
let highlights: Map<string, string> | null = null;
const codeKey = (lang: string, code: string): string => `${lang}\u0000${code}`;

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const name = langOf(lang);
      const body =
        (name && highlights?.get(codeKey(name, text))) ||
        `<pre><code>${escapeHtml(text)}</code></pre>`;
      const label = name ? `<span class="code-lang">${escapeHtml(name)}</span>` : '<span></span>';
      return (
        `<div class="code-block" data-lang="${escapeHtml(name)}"><div class="code-head">${label}` +
        `<button type="button" class="code-copy" data-copy-code aria-label="Copy code">Copy</button>` +
        `</div>${body}</div>`
      );
    },
  },
});

let hooked = false;
const sanitize = (html: string): string => {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return DOMPurify.sanitize(html);
};

const render = (md: string): string => sanitize(marked.parse(md) as string);

/** Markdown → sanitized HTML, code blocks as plain text. */
export const renderMarkdown = (md: string): string => {
  highlights = null;
  return render(md);
};

// ---- shiki, loaded lazily ----------------------------------------------------

let highlighter: Promise<HighlighterCore> | null = null;
let languages: Promise<Record<string, () => Promise<unknown>>> | null = null;

const loadHighlighter = (): Promise<HighlighterCore> =>
  (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes'),
      ]);
    return createHighlighterCore({
      themes: [bundledThemes['github-light'](), bundledThemes['github-dark']()],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })());

const loadLanguages = () =>
  (languages ??= import('shiki/langs').then(
    (m) => m.bundledLanguages as unknown as Record<string, () => Promise<unknown>>,
  ));

const codeCache = new Map<string, string | null>();

/** Highlighted `<pre>` for one block, or null (unknown language, too big, or failure). */
export const highlightCode = async (code: string, lang: string): Promise<string | null> => {
  const id = lang.toLowerCase();
  if (!id || code.split('\n').length > HIGHLIGHT_MAX_LINES) return null;
  const key = codeKey(id, hashText(code));
  if (codeCache.has(key)) return codeCache.get(key) ?? null;
  let html: string | null = null;
  try {
    const importer = (await loadLanguages())[id];
    if (importer) {
      const hl = await loadHighlighter();
      if (!hl.getLoadedLanguages().includes(id)) {
        await hl.loadLanguage(importer() as Parameters<HighlighterCore['loadLanguage']>[0]);
      }
      html = hl.codeToHtml(code, {
        lang: id,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      });
    }
  } catch {
    html = null;
  }
  remember(codeCache, key, html);
  return html;
};

const FENCE_WITH_LANG = /^ {0,3}(`{3,}|~{3,})[ \t]*[^\s`~]/m;

/** True when `md` has a fenced block with a language (worth highlighting). */
export const hasHighlightableCode = (md: string): boolean => FENCE_WITH_LANG.test(md);

const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Markdown → sanitized HTML with highlighted code blocks (one block per task, so input stays responsive). */
export const highlightMarkdown = async (md: string): Promise<string> => {
  const blocks: { text: string; lang: string }[] = [];
  marked.walkTokens(marked.lexer(md), (t) => {
    if (t.type === 'code') {
      const lang = langOf((t as Tokens.Code).lang);
      if (lang) blocks.push({ text: (t as Tokens.Code).text, lang });
    }
  });
  const done = new Map<string, string>();
  for (const b of blocks) {
    const html = await highlightCode(b.text, b.lang);
    if (html) done.set(codeKey(b.lang, b.text), html);
    await yieldToUi();
  }
  highlights = done;
  try {
    return render(md);
  } finally {
    highlights = null;
  }
};

// ---- per-item cache ------------------------------------------------------------

const htmlCache = new Map<string, { html: string; highlighted: boolean }>();

const remember = <V>(cache: Map<string, V>, key: string, value: V): void => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
};

const itemKey = (id: string, md: string): string => `${id}:${hashText(md)}`;

/** Cached HTML for an item's markdown: the highlighted version once known, else plain. */
export const renderCached = (id: string, md: string): string => {
  const key = itemKey(id, md);
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit.html;
  const html = renderMarkdown(md);
  remember(htmlCache, key, { html, highlighted: !hasHighlightableCode(md) });
  return html;
};

/** True while an item's markdown has code blocks that were not highlighted yet. */
export const needsHighlight = (id: string, md: string): boolean =>
  hasHighlightableCode(md) && htmlCache.get(itemKey(id, md))?.highlighted !== true;

/** Highlights an item's markdown and caches the result under the same key as `renderCached`. */
export const highlightCached = async (id: string, md: string): Promise<string> => {
  const html = await highlightMarkdown(md);
  remember(htmlCache, itemKey(id, md), { html, highlighted: true });
  return html;
};
