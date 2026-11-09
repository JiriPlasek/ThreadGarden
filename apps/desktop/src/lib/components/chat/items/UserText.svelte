<script lang="ts">
  import { type ImageRef } from '@threadgarden/protocol';
  import AttachmentBadge from '../../composer/AttachmentBadge.svelte';
  import { restoreMessage, sentImageMap, tagsIn } from '../../composer/tags';
  let {
    text,
    images = [],
    limit,
  }: { text: string; images?: ImageRef[]; limit?: number } = $props();
  const message = $derived(restoreMessage(text));
  const mapped = $derived(sentImageMap(message.text, images));
  const display = $derived(message.text);
  const shown = $derived(limit === undefined ? display : display.slice(0, limit));
  let opened = $state<Record<number, boolean>>({});
  const parts = $derived.by(() => {
    let start = 0;
    const out = [];
    for (const tag of tagsIn(shown)) {
      const image = tag.kind === 'image' ? mapped[tag.number] : undefined;
      const paste = tag.kind === 'paste' ? message.attachments.pastes[tag.number] : undefined;
      if (!image && !paste) continue;
      out.push({ before: shown.slice(start, tag.start), tag, image, paste });
      start = tag.end;
    }
    return { tags: out, tail: shown.slice(start) };
  });
</script>

<div class="pr-6 break-words whitespace-pre-wrap">
  {#each parts.tags as part (part.tag.start)}{part.before}<AttachmentBadge
      label={part.tag.label}
      image={part.image}
      text={part.paste?.text}
      onclick={part.paste
        ? () => (opened = { ...opened, [part.tag.number]: !opened[part.tag.number] })
        : undefined}
    />{#if part.paste && opened[part.tag.number]}<pre
        aria-label="Pasted text #{part.tag.number}"
        class="my-2 max-h-96 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap">{part
          .paste.text}</pre>{/if}{/each}{parts.tail}{#if shown.length < display.length}…{/if}
</div>
