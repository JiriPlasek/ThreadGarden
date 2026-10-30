<script lang="ts">
  import type { ImageRef } from '@pahub/protocol';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ImagePlusIcon from '@lucide/svelte/icons/image-plus';
  import SquareIcon from '@lucide/svelte/icons/square';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { useApp } from '#lib/state/context.js';
  import type { FileSuggestion, SlashCommand } from '#lib/state/interaction.svelte.js';
  import Attachments from './Attachments.svelte';
  import { caretLineTop } from './caret';
  import {
    filterCommands,
    IMAGE_TYPES,
    imageFiles,
    imageProblem,
    mentionAt,
    mentionText,
    readImage,
    replaceRange,
    slashAt,
    type Token,
  } from './input';
  import MentionPicker from './MentionPicker.svelte';
  import SlashMenu from './SlashMenu.svelte';

  /**
   * The message box (spec §6.4 "Input"): multi-line, Enter sends (Shift+Enter
   * for a new line; with `enterToSend` off, Ctrl/Cmd+Enter sends), `@` opens
   * the file picker, `/` at the start the command menu, pasted or dropped
   * images are attached. The draft is kept per `draftKey` (saved debounced).
   *
   * Keystroke budget (spec §8, ≤ 16 ms): per input event this only reads the
   * caret, scans the current word and resizes the box; file suggestions are
   * debounced, the draft write is debounced, and the caret is measured only
   * while a picker is open.
   *
   * Esc closes an open picker here; otherwise it bubbles to the chat view,
   * which interrupts a working chat.
   */
  let {
    draftKey,
    cwd,
    commandScope,
    working = false,
    queued = 0,
    placeholder = 'Message Claude…',
    label = 'Message',
    autofocus = false,
    onSubmit,
    onInterrupt,
    textarea = $bindable(null),
  }: {
    draftKey: string;
    /** Folder whose files `@` suggests. */
    cwd: string;
    /** Where slash commands come from: the chat, or the folder of a new chat. */
    commandScope: { sessionId?: string; cwd?: string };
    /** Claude is working: a message now is queued, and Stop is offered. */
    working?: boolean;
    /** Messages sent while working that wait for the current turn. */
    queued?: number;
    placeholder?: string;
    label?: string;
    autofocus?: boolean;
    /** Sends; resolves true when the message went out (the box clears) or false to keep it. */
    onSubmit: (text: string, images: ImageRef[]) => Promise<boolean>;
    onInterrupt?: () => void;
    textarea?: HTMLTextAreaElement | null;
  } = $props();

  const { settings, interaction } = useApp();
  const uid = $props.id();
  const listId = `${uid}-list`;

  /** Debounce for `files.suggest` while typing after `@`. */
  const SUGGEST_DELAY_MS = 80;
  const MAX_HEIGHT_PX = 240;

  let text = $state(untrack(() => interaction.cachedDraft(draftKey)) ?? '');
  let images = $state.raw<ImageRef[]>([]);
  let imageError = $state<string | null>(null);
  let sending = $state(false);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  // ── pickers ─────────────────────────────────────────────────────────────

  let picker = $state.raw<{ kind: 'mention' | 'slash'; token: Token } | null>(null);
  let active = $state(0);
  let anchorBottom = $state(0);
  let files = $state.raw<FileSuggestion[]>([]);
  let filesLoading = $state(false);
  let commands = $state.raw<SlashCommand[] | null>(null);
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestGen = 0;

  const commandItems = $derived(
    picker?.kind === 'slash' ? filterCommands(commands ?? [], picker.token.query) : [],
  );
  const optionCount = $derived(
    picker?.kind === 'mention' ? files.length : picker ? commandItems.length : 0,
  );
  const activeId = $derived(
    picker && optionCount > 0 ? `${listId}-opt-${Math.min(active, optionCount - 1)}` : undefined,
  );

  const closePicker = (): void => {
    picker = null;
    clearTimeout(suggestTimer);
    suggestGen++;
  };

  const loadCommands = (): void => {
    if (commands !== null) return;
    interaction
      .commands(commandScope)
      .then((list) => (commands = list))
      .catch(() => (commands = []));
  };

  const fetchFiles = (query: string): void => {
    clearTimeout(suggestTimer);
    const gen = ++suggestGen;
    filesLoading = true;
    suggestTimer = setTimeout(() => {
      interaction
        .suggestFiles(cwd, query)
        .then((list) => {
          if (gen !== suggestGen) return;
          files = list;
          active = 0;
        })
        .catch(() => {
          if (gen === suggestGen) files = [];
        })
        .finally(() => {
          if (gen === suggestGen) filesLoading = false;
        });
    }, SUGGEST_DELAY_MS);
  };

  /** Re-reads which picker the caret is in (after typing, clicking or picking). */
  const updatePicker = (): void => {
    const el = textarea;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    if (el.selectionEnd !== el.selectionStart) return closePicker();
    const slash = slashAt(text, caret);
    const mention = slash ? null : mentionAt(text, caret);
    const prev = picker;
    if (slash) {
      picker = { kind: 'slash', token: slash };
      if (prev?.kind !== 'slash' || prev.token.query !== slash.query) active = 0;
      loadCommands();
    } else if (mention) {
      picker = { kind: 'mention', token: mention };
      if (prev?.kind !== 'mention' || prev.token.query !== mention.query) fetchFiles(mention.query);
    } else {
      if (prev) closePicker();
      return;
    }
    anchorBottom = el.clientHeight - caretLineTop(el, picker.token.start);
  };

  const pick = async (i: number): Promise<void> => {
    const p = picker;
    if (!p) return;
    let next: { text: string; caret: number } | null = null;
    if (p.kind === 'mention') {
      const f = files[i];
      if (f) next = replaceRange(text, p.token.start, p.token.end, mentionText(f.path, f.kind));
    } else {
      const c = commandItems[i];
      if (c) next = replaceRange(text, 0, p.token.end, `/${c.name} `);
    }
    if (!next) return;
    closePicker();
    text = next.text;
    interaction.saveDraft(draftKey, text);
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(next.caret, next.caret);
    resize();
    // A folder keeps the picker open inside it.
    if (p.kind === 'mention' && files[i]?.kind === 'dir') updatePicker();
  };

  // ── typing ──────────────────────────────────────────────────────────────

  const resize = (): void => {
    const el = textarea;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT_PX, el.scrollHeight)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  };

  const oninput = (): void => {
    interaction.saveDraft(draftKey, text);
    resize();
    updatePicker();
  };

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if ((!value && images.length === 0) || sending) return;
    sending = true;
    try {
      const sent = await onSubmit(value, images);
      if (sent) {
        text = '';
        images = [];
        imageError = null;
        closePicker();
        interaction.clearDraft(draftKey);
        await tick();
        resize();
      }
    } finally {
      sending = false;
    }
  };

  const onkeydown = (e: KeyboardEvent): void => {
    if (picker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePicker();
        return;
      }
      if (optionCount > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          active = (Math.min(active, optionCount - 1) + step + optionCount) % optionCount;
          return;
        }
        const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
        if ((e.key === 'Enter' || e.key === 'Tab') && plain && !e.isComposing) {
          e.preventDefault();
          void pick(Math.min(active, optionCount - 1));
          return;
        }
      }
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const sends = settings.value.enterToSend ? !e.shiftKey && !e.altKey : mod;
    if (sends) {
      e.preventDefault();
      void submit();
    }
  };

  // ── images ──────────────────────────────────────────────────────────────

  const attach = async (list: File[]): Promise<void> => {
    const problems: string[] = [];
    const ok: File[] = [];
    for (const f of list) {
      const p = imageProblem(f);
      if (p) problems.push(p);
      else ok.push(f);
    }
    imageError = problems.length ? problems.join('; ') : null;
    try {
      const read = await Promise.all(ok.map(readImage));
      images = [...images, ...read];
    } catch (err) {
      imageError = err instanceof Error ? err.message : String(err);
    }
  };

  const onpaste = (e: ClipboardEvent): void => {
    const list = imageFiles(e.clipboardData);
    if (list.length > 0) void attach(list);
  };

  const ondragover = (e: DragEvent): void => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dragging = true;
  };

  const ondrop = (e: DragEvent): void => {
    dragging = false;
    const list = imageFiles(e.dataTransfer);
    if (list.length === 0) return;
    e.preventDefault();
    void attach(list);
  };

  const onPickFiles = (e: Event & { currentTarget: HTMLInputElement }): void => {
    void attach([...(e.currentTarget.files ?? [])]);
    e.currentTarget.value = '';
  };

  // ── lifecycle ───────────────────────────────────────────────────────────

  onMount(() => {
    const key = draftKey;
    if (interaction.cachedDraft(key) === undefined) {
      interaction
        .loadDraft(key)
        .then((saved) => {
          if (!text && saved) {
            text = saved;
            void tick().then(resize);
          }
        })
        .catch(() => {});
    }
    void tick().then(() => {
      resize();
      if (autofocus) textarea?.focus();
    });
  });

  onDestroy(() => {
    clearTimeout(suggestTimer);
    interaction.flushDraft(draftKey);
  });

  const hint = $derived(
    working && text.trim()
      ? 'Claude is working: this message will be queued and sent when the current turn ends.'
      : null,
  );
</script>

<!-- The drop zone covers the whole composer; the textarea and buttons inside handle the keyboard. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="bg-background relative rounded-lg border shadow-xs {dragging
    ? 'ring-2 ring-amber-500/50'
    : ''} focus-within:ring-ring/40 focus-within:ring-2"
  {ondragover}
  ondragleave={() => (dragging = false)}
  {ondrop}
>
  <Attachments {images} onRemove={(i) => (images = images.filter((_, j) => j !== i))} />

  <div class="relative">
    {#if picker}
      <div
        class="bg-popover text-popover-foreground absolute right-2 left-2 z-20 rounded-md border shadow-md"
        style:bottom="{anchorBottom}px"
      >
        {#if picker.kind === 'mention'}
          <MentionPicker
            id={listId}
            items={files}
            {active}
            loading={filesLoading}
            onPick={(i) => void pick(i)}
            onHover={(i) => (active = i)}
          />
        {:else}
          <SlashMenu
            id={listId}
            items={commandItems}
            {active}
            loading={commands === null}
            onPick={(i) => void pick(i)}
            onHover={(i) => (active = i)}
          />
        {/if}
      </div>
    {/if}
    <textarea
      bind:this={textarea}
      bind:value={text}
      rows="1"
      class="placeholder:text-muted-foreground block w-full resize-none overflow-hidden bg-transparent px-3 pt-2.5 pb-1 text-sm leading-5 outline-none"
      aria-label={label}
      aria-autocomplete="list"
      aria-controls={picker ? listId : undefined}
      aria-activedescendant={activeId}
      {placeholder}
      {oninput}
      {onkeydown}
      {onpaste}
      onclick={updatePicker}
      onblur={() => setTimeout(closePicker, 0)}></textarea>
  </div>

  {#if imageError}
    <p class="text-destructive px-3 pb-1 text-xs" role="alert">{imageError}</p>
  {/if}

  <div class="flex items-center gap-1 px-2 pb-1.5">
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground hover:bg-muted flex size-7 items-center justify-center rounded-md"
      aria-label="Attach images"
      title="Attach images (or paste / drop them)"
      onclick={() => fileInput?.click()}
    >
      <ImagePlusIcon class="size-4" aria-hidden="true" />
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept={IMAGE_TYPES.join(',')}
      multiple
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      onchange={onPickFiles}
    />
    <div class="text-muted-foreground min-w-0 flex-1 truncate px-1 text-[11px]" role="status">
      {#if queued > 0}
        <span class="rounded bg-amber-500/15 px-1.5 py-px text-amber-900 dark:text-amber-200"
          >{queued} message{queued === 1 ? '' : 's'} queued</span
        >
      {:else if hint}
        {hint}
      {/if}
    </div>
    {#if working && onInterrupt}
      <button
        type="button"
        class="hover:bg-muted flex h-7 items-center gap-1 rounded-md border px-2 text-xs"
        title="Stop (Esc)"
        onclick={onInterrupt}
      >
        <SquareIcon class="size-3 fill-current" aria-hidden="true" /> Stop
      </button>
    {/if}
    <button
      type="button"
      class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md disabled:opacity-40"
      aria-label={working ? 'Queue message' : 'Send'}
      title={settings.value.enterToSend ? 'Send (Enter)' : 'Send (Ctrl+Enter)'}
      disabled={sending || (!text.trim() && images.length === 0)}
      onclick={() => void submit()}
    >
      <ArrowUpIcon class="size-4" aria-hidden="true" />
    </button>
  </div>
</div>
