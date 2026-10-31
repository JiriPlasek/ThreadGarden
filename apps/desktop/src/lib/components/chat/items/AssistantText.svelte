<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import { onDestroy } from 'svelte';
  import { highlightCached, needsHighlight, renderCached, renderMarkdown } from '#lib/markdown.js';
  import { copyText, openExternal } from '#lib/native.js';

  /**
   * Assistant markdown. While streaming the text is re-rendered at most once per
   * frame (in place: same element); once complete it is rendered from the
   * per-item cache and its code blocks are highlighted in the background.
   */
  let {
    item,
  }: { item: Pick<Extract<ChatItem, { kind: 'assistantText' }>, 'id' | 'markdown' | 'streaming'> } =
    $props();

  const initial = (): string =>
    item.streaming ? renderMarkdown(item.markdown) : renderCached(item.id, item.markdown);

  const initialMarkdown = (): string => item.markdown;

  let html = $state(initial());
  /** The markdown `html` currently shows. */
  let shownMarkdown = initialMarkdown();
  let frame = 0;
  let pending: string | null = null;

  const nextFrame = (cb: () => void): number =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, 16) as unknown as number);
  const cancelFrame = (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    clearTimeout(id);
  };

  $effect(() => {
    const { id, markdown, streaming } = item;
    if (streaming) {
      if (markdown === shownMarkdown) return;
      pending = markdown;
      if (!frame) {
        frame = nextFrame(() => {
          frame = 0;
          if (pending === null) return;
          shownMarkdown = pending;
          html = renderMarkdown(pending);
          pending = null;
        });
      }
      return;
    }
    if (frame) cancelFrame(frame);
    frame = 0;
    pending = null;
    shownMarkdown = markdown;
    html = renderCached(id, markdown);
    if (needsHighlight(id, markdown)) {
      void highlightCached(id, markdown).then((highlighted) => {
        if (item.id === id && item.markdown === markdown && !item.streaming) html = highlighted;
      });
    }
  });

  onDestroy(() => {
    if (frame) cancelFrame(frame);
  });

  /** Links open outside Threadgarden; code blocks' copy buttons copy their code. */
  const onclick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    const copy = target?.closest('[data-copy-code]');
    if (copy) {
      // Never let this click do anything else (e.g. follow an enclosing link).
      e.preventDefault();
      e.stopPropagation();
      const code = copy.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
      void copyText(code).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      });
      return;
    }
    followLink(e, true);
  };

  /** Middle-click opens like a click; no mouse button ever navigates the webview (R23). */
  const onauxclick = (e: MouseEvent): void => {
    followLink(e, e.button === 1);
  };

  const followLink = (e: MouseEvent, open: boolean): void => {
    const link = (e.target as Element | null)?.closest('a');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (open && href) openExternal(href).catch(() => {});
  };
</script>

<!-- Clicks are delegated from the rendered links and buttons, which handle the keyboard themselves. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md text-sm" class:streaming={item.streaming} {onclick} {onauxclick}>
  <!-- Sanitized by DOMPurify (markdown.ts). -->
  {@html html}
</div>
