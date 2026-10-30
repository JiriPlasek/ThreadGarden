<script lang="ts">
  import type { ChatSummary } from '@pahub/protocol';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
  import * as ContextMenu from '#lib/components/ui/context-menu/index.js';
  import { fullTime, relativeTime } from '#lib/format/time.js';
  import { cn } from '#lib/utils.js';
  import { externalLabel, previewLine, rawStatus } from './chat-info';
  import StatusIcon from './StatusIcon.svelte';

  let {
    chat,
    id,
    index,
    setSize,
    selected,
    active,
    projectName,
    now,
    onOpen,
    onRename,
    onTogglePin,
  }: {
    chat: ChatSummary;
    /** DOM id, referenced by the list's `aria-activedescendant`. */
    id: string;
    index: number;
    setSize: number;
    /** The keyboard cursor. */
    selected: boolean;
    /** Open in the active tab. */
    active: boolean;
    /** Shown when the place spans projects; omitted inside a project. */
    projectName?: string;
    now: number;
    onOpen: (chat: ChatSummary) => void;
    onRename: (chat: ChatSummary) => void;
    onTogglePin: (chat: ChatSummary) => void;
  } = $props();

  const line = $derived(previewLine(chat));
  const waiting = $derived(chat.status === 'needsYou' && !!chat.waitingFor);
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        {id}
        role="option"
        aria-selected={selected}
        aria-setsize={setSize}
        aria-posinset={index + 1}
        data-session-id={chat.sessionId}
        data-active={active || undefined}
        tabindex="-1"
        class={cn(
          'relative mx-1 flex h-full cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2.5 select-none',
          'hover:bg-accent/60',
          selected && 'bg-accent text-accent-foreground hover:bg-accent',
          active &&
            'before:bg-primary before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full',
        )}
        onclick={() => onOpen(chat)}
      >
        <div class="flex min-w-0 items-center gap-2">
          <StatusIcon status={chat.status} raw={rawStatus(chat)} />
          <span class="min-w-0 truncate text-[0.8125rem] leading-5 font-medium">{chat.title}</span>
          {#if chat.pinned}
            <PinIcon class="text-muted-foreground size-3.5 shrink-0" aria-label="Pinned" />
          {/if}
          <time
            class="text-muted-foreground ml-auto shrink-0 text-[0.6875rem] tabular-nums"
            datetime={chat.lastActivity > 0 ? new Date(chat.lastActivity).toISOString() : undefined}
            title={fullTime(chat.lastActivity)}>{relativeTime(chat.lastActivity, now)}</time
          >
        </div>
        <div
          class="text-muted-foreground flex min-w-0 items-center gap-1.5 pl-5.5 text-xs leading-4"
        >
          {#if projectName}
            <span class="bg-muted max-w-[45%] shrink-0 truncate rounded px-1 text-[0.6875rem]"
              >{projectName}</span
            >
          {/if}
          <span class={cn('min-w-0 truncate', waiting && 'text-amber-700 dark:text-amber-400')}
            >{line}</span
          >
          {#if chat.external}
            <span
              role="img"
              class="ml-auto shrink-0"
              aria-label={externalLabel(chat)}
              title={externalLabel(chat)}
            >
              <SquareTerminalIcon class="size-3.5" aria-hidden="true" />
            </span>
          {/if}
        </div>
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="min-w-40">
    <ContextMenu.Item class="py-1 text-xs" onSelect={() => onOpen(chat)}>Open</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item class="py-1 text-xs" onSelect={() => onTogglePin(chat)}>
      {#if chat.pinned}<PinOffIcon /> Unpin{:else}<PinIcon /> Pin{/if}
    </ContextMenu.Item>
    <ContextMenu.Item class="py-1 text-xs" onSelect={() => onRename(chat)}>
      <PencilIcon /> Rename…
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
