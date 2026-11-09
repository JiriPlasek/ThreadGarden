<script lang="ts">
  import { onDestroy } from 'svelte';
  import AttachmentBadge from './AttachmentBadge.svelte';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import { labelForPaste, tagsIn, type AttachmentsState, type Tag } from './tags';
  let {
    text,
    attachments,
    textarea,
  }: { text: string; attachments: AttachmentsState; textarea: HTMLTextAreaElement | null } =
    $props();
  let mirror = $state<HTMLDivElement | null>(null);
  let scroll = $state(0);
  let width = $state(0);
  let hover = $state<{ tag: Tag; left: number; top: number } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = (): void => clearTimeout(timer);
  const hide = (): void => {
    timer = setTimeout(() => (hover = null), 180);
  };
  onDestroy(keep);
  const tags = $derived(
    tagsIn(text).filter(
      (t) =>
        t.kind === 'image' ||
        (attachments.pastes[t.number] !== undefined &&
          t.label === labelForPaste(t.number, attachments.pastes[t.number]!)),
    ),
  );
  const parts = $derived.by(() => {
    let start = 0;
    return [
      ...tags.map((tag) => {
        const before = text.slice(start, tag.start);
        start = tag.end;
        return { before, tag };
      }),
      { before: text.slice(start), tag: null },
    ];
  });
  $effect(() => {
    const el = textarea;
    if (!el) return;
    const sync = (): void => {
      width = el.clientWidth;
      scroll = el.scrollTop;
      hover = null;
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    sync();
    const move = (event: PointerEvent): void => {
      keep();
      let found: typeof hover = null;
      for (const span of mirror?.querySelectorAll<HTMLElement>('[data-tag]') ?? []) {
        for (const rect of span.getClientRects()) {
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            const tag = tags[Number(span.dataset.tag)];
            if (tag) found = { tag, left: rect.left, top: rect.top - 6 };
          }
        }
      }
      hover = found;
    };
    el.addEventListener('scroll', sync);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('keydown', hide);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', sync);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', hide);
      el.removeEventListener('keydown', hide);
    };
  });
</script>

<div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
  <div
    bind:this={mirror}
    class="mirror px-3 pt-2.5 pb-1 text-sm leading-5"
    style:transform="translateY(-{scroll}px)"
    style:width={width ? `${width}px` : '100%'}
  >
    {#each parts as part, i (i)}{part.before}{#if part.tag}<span
          data-tag={i}
          class="rounded bg-sky-500/15 {part.tag.kind === 'image' &&
          !attachments.images[part.tag.number]
            ? 'text-muted-foreground'
            : 'text-sky-900 dark:text-sky-200'}">{part.tag.label}</span
        >{/if}{/each}{'\n'}
  </div>
</div>
{#if hover}
  <AttachmentPreview
    label={hover.tag.label}
    image={hover.tag.kind === 'image' ? attachments.images[hover.tag.number] : undefined}
    text={hover.tag.kind === 'paste' ? attachments.pastes[hover.tag.number]?.text : undefined}
    missing={hover.tag.kind === 'image' && !attachments.images[hover.tag.number]}
    left={hover.left}
    top={hover.top}
    onmouseenter={keep}
    onmouseleave={hide}
  />
{/if}
<div
  class="sr-only focus-within:not-sr-only focus-within:relative focus-within:z-30"
  aria-label="Attachment previews"
>
  {#each tags as tag (tag.start)}
    <AttachmentBadge
      label={tag.label}
      image={tag.kind === 'image' ? attachments.images[tag.number] : undefined}
      text={tag.kind === 'paste' ? attachments.pastes[tag.number]?.text : undefined}
      missing={tag.kind === 'image' && !attachments.images[tag.number]}
    />
  {/each}
</div>

<style>
  .mirror {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    tab-size: 8;
  }
</style>
