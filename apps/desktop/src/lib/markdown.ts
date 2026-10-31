/**
 * Markdown for chat messages: `marked` (GFM) → a dedicated, restrictive
 * DOMPurify instance. Model output may only produce plain document markup: no
 * styles, classes, ids, forms, buttons, frames or scripts; links keep http(s)
 * targets only (Threadgarden opens them, ruling R23); remote images become links and
 * only small raster `data:` images stay inline (ruling R22).
 *
 * Code blocks never pass through the model-facing sanitizer as markup: the
 * parser leaves an unguessable placeholder, and after sanitizing Threadgarden inserts
 * its own block (escaped code or shiki output, a language label and a Copy
 * button). `highlightMarkdown` highlights with shiki, loaded on first use
 * (JavaScript regex engine, no WASM) with each language fetched on demand;
 * huge blocks are never highlighted.
 */
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import type { HighlighterCore } from 'shiki/core';

/** Blocks longer than this stay plain text (highlighting them would stall the UI). */
export const HIGHLIGHT_MAX_LINES = 2000;
/** Inline `data:` images longer than this (characters) are not rendered. */
export const MAX_DATA_IMAGE_CHARS = 2_000_000;
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

const codeKey = (lang: string, code: string): string => `${lang}\u0000${code}`;

/** True for absolute http(s) URLs: the only link targets Threadgarden keeps. */
const isHttpUrl = (url: string): boolean => /^https?:\/\/[^/\s]/i.test(url.trim());

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
/** Small raster `data:` images are the only images rendered inline (R22). */
const isInlineImage = (src: string): boolean =>
  src.length <= MAX_DATA_IMAGE_CHARS && DATA_IMAGE.test(src);

// ---- parsing ---------------------------------------------------------------------

type CodeBlock = { text: string; lang: string };

/** Code blocks of the parse in progress (parsing is synchronous). */
let blocks: CodeBlock[] = [];

const randomHex = (): string => {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return [...a].map((n) => n.toString(16).padStart(8, '0')).join('');
};
/**
 * Fresh per render: model output cannot know it, so it cannot forge a
 * code-block placeholder (and a nonce leaked into one render is useless later).
 */
let nonce = randomHex();
/**
 * A placeholder, intact (`<pre>…</pre>`) or as text the HTML parser moved out
 * of its `<pre>`; only intact ones of the current render become code blocks.
 */
const PLACEHOLDER = /(<pre>)?PAHUB-CODE-([0-9a-f]+)-(\d+)(<\/pre>)?/g;
/** Block content that must never sit inside a link (a click on it would follow the link). */
const BLOCK_CONTENT =
  'p, pre, div, ul, ol, li, blockquote, table, h1, h2, h3, h4, h5, h6, hr, details, summary';

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const i = blocks.push({ text, lang: langOf(lang) }) - 1;
      return `<pre>PAHUB-CODE-${nonce}-${i}</pre>\n`;
    },
    image({ href, title, text }: Tokens.Image): string {
      if (isInlineImage(href)) {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t}>`;
      }
      if (href.startsWith('data:')) return escapeHtml(`[image: ${text || 'not shown'}]`);
      // Remote images are never loaded: the alt text (or the URL) links to them.
      const label = escapeHtml(text || href);
      return isHttpUrl(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    },
  },
});

// ---- sanitizing ------------------------------------------------------------------

type Purifier = ReturnType<typeof DOMPurify>;
let markdownPurifier: Purifier | null = null;
let codePurifier: Purifier | null = null;

/** What model-written markdown (and the HTML inside it) may produce. */
const MARKDOWN_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'strong',
    'em',
    'b',
    'i',
    'del',
    's',
    'a',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'img',
    'input',
    'kbd',
    'sup',
    'sub',
    'details',
    'summary',
  ],
  ALLOWED_ATTR: [
    'href',
    'title',
    'alt',
    'src',
    'type',
    'checked',
    'disabled',
    'start',
    'align',
    'colspan',
    'rowspan',
  ],
  FORBID_TAGS: [
    'style',
    'link',
    'meta',
    'base',
    'form',
    'button',
    'textarea',
    'select',
    'option',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'script',
    'template',
    'svg',
    'math',
    'video',
    'audio',
    'source',
  ],
  FORBID_ATTR: ['style', 'class', 'id', 'action', 'formaction', 'target'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true as const,
};

/** Shiki's output: generated by Threadgarden from escaped code, checked anyway. */
const CODE_CONFIG = {
  ALLOWED_TAGS: ['pre', 'code', 'span'],
  ALLOWED_ATTR: ['class', 'style', 'tabindex'],
};

const sanitizeMarkdown = (html: string): string => {
  markdownPurifier ??= DOMPurify(window);
  const fragment = markdownPurifier.sanitize(html, MARKDOWN_CONFIG);
  // Rules the tag/attribute lists cannot express.
  for (const a of fragment.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (href !== null && !isHttpUrl(href)) a.removeAttribute('href');
    if (a.hasAttribute('href')) a.setAttribute('rel', 'noopener noreferrer');
  }
  for (const img of fragment.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!isInlineImage(src)) img.replaceWith(img.getAttribute('alt') ?? '');
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type') === 'checkbox') input.setAttribute('disabled', '');
    else input.remove();
  }
  // Links keep inline content only: one wrapped around a code block (or any
  // block) is unwrapped, so no click inside a block can follow a link.
  for (const a of fragment.querySelectorAll('a')) {
    if (a.querySelector(BLOCK_CONTENT)) a.replaceWith(...a.childNodes);
  }
  const box = document.createElement('div');
  box.append(fragment);
  return box.innerHTML;
};

const sanitizeCode = (html: string): string => {
  codePurifier ??= DOMPurify(window);
  return codePurifier.sanitize(html, CODE_CONFIG);
};

/** Threadgarden's own code block markup, inserted after sanitizing. */
const codeBlockHtml = (b: CodeBlock, highlighted: string | undefined): string => {
  const body = highlighted
    ? sanitizeCode(highlighted)
    : `<pre><code>${escapeHtml(b.text)}</code></pre>`;
  const label = b.lang ? `<span class="code-lang">${escapeHtml(b.lang)}</span>` : '<span></span>';
  return (
    `<div class="code-block" data-lang="${escapeHtml(b.lang)}"><div class="code-head">${label}` +
    `<button type="button" class="code-copy" data-copy-code aria-label="Copy code">Copy</button>` +
    `</div>${body}</div>`
  );
};

const render = (md: string, highlights?: Map<string, string>): string => {
  blocks = [];
  nonce = randomHex();
  const raw = marked.parse(md) as string;
  const found = blocks;
  const current = nonce;
  blocks = [];
  // One pass, so code inserted here is never rescanned: intact placeholders of
  // this render become code blocks, anything else that looks like one goes.
  return sanitizeMarkdown(raw).replace(PLACEHOLDER, (_m, open, n: string, i: string, close) => {
    const b = open && close && n === current ? found[Number(i)] : undefined;
    return b ? codeBlockHtml(b, highlights?.get(codeKey(b.lang, b.text))) : '';
  });
};

/** Markdown → sanitized HTML, code blocks as plain text. */
export const renderMarkdown = (md: string): string => render(md);

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
  return render(md, done);
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
