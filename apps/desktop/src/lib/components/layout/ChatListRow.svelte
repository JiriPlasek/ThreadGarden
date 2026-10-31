<script lang="ts">
  import type { Bucket, ChatSummary, ScheduledSend } from '@threadgarden/protocol';
  import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
  import * as ContextMenu from '#lib/components/ui/context-menu/index.js';
  import { formatHoldUntil } from '#lib/format/hold.js';
  import { fullTime, relativeTime } from '#lib/format/time.js';
  import { cn } from '#lib/utils.js';
  import { externalLabel, previewLine, rawStatus } from './chat-info';
  import RunningBadge from './RunningBadge.svelte';
  import ScheduledBadge from './ScheduledBadge.svelte';
  import StatusIcon, { isYourTurn } from './StatusIcon.svelte';

  let {
    chat,
    id,
    index,
    setSize,
    describedBy,
    selected,
    checked = false,
    cursor = false,
    active,
    projectName,
    now,
    running = 0,
    scheduled = [],
    onOpen,
    onRename,
    onTogglePin,
    onMove,
  }: {
    chat: ChatSummary;
    /** DOM id, referenced by the list's `aria-activedescendant`. */
    id: string;
    index: number;
    setSize: number;
    /** Id of the element naming the row's section (v1.2 §2). */
    describedBy?: string;
    /** `aria-selected`: in the multi-selection, or the keyboard cursor when nothing is selected. */
    selected: boolean;
    /** In the multi-selection (v1.2 §3). */
    checked?: boolean;
    /** The keyboard cursor (`aria-activedescendant`); marked apart from the selection. */
    cursor?: boolean;
    /** Open in the active tab. */
    active: boolean;
    /** Shown when the place spans projects; omitted inside a project. */
    projectName?: string;
    now: number;
    /** Running agents and processes (known for chats open in a tab only). */
    running?: number;
    /** v1.3 B: the chat's scheduled messages (the clock badge). */
    scheduled?: readonly ScheduledSend[];
    /** A click (with its modifiers: Ctrl/Cmd and Shift select), or "Open" from the menu. */
    onOpen: (chat: ChatSummary, e?: MouseEvent) => void;
    onRename: (chat: ChatSummary) => void;
    onTogglePin: (chat: ChatSummary) => void;
    /** Make active / Put on hold… / Archive (v1.2 §3). */
    onMove?: (chat: ChatSummary, bucket: Bucket) => void;
  } = $props();

  const line = $derived(previewLine(chat));
  const waiting = $derived(chat.status === 'needsYou' && !!chat.waitingFor);
  const yourTurn = $derived(isYourTurn(chat.status, chat.unread));
  const onHold = $derived(chat.bucket === 'onHold');
  const archived = $derived(chat.bucket === 'archived');
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
        aria-describedby={describedBy}
        data-session-id={chat.sessionId}
        data-active={active || undefined}
        data-cursor={cursor || undefined}
        tabindex="-1"
        class={cn(
          'relative mx-1 flex h-full cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2.5 select-none',
          'hover:bg-accent/60',
          selected && 'bg-accent text-accent-foreground hover:bg-accent',
          checked && 'bg-primary/10 ring-primary/40 hover:bg-primary/15 ring-1 ring-inset',
          checked && cursor && 'ring-primary ring-2',
          cursor && !selected && 'ring-ring ring-1 ring-inset',
          active &&
            'before:bg-primary before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full',
        )}
        onclick={(e) => onOpen(chat, e)}
      >
        <div class="flex min-w-0 items-center gap-2">
          <StatusIcon status={chat.status} raw={rawStatus(chat)} unread={chat.unread} />
          <span class="min-w-0 truncate text-[0.8125rem] leading-5 font-medium">{chat.title}</span>
          {#if chat.pinned}
            <PinIcon class="text-muted-foreground size-3.5 shrink-0" aria-label="Pinned" />
          {/if}
          {#if archived}
            <span role="img" class="shrink-0" aria-label="Archived" title="Archived">
              <ArchiveIcon class="text-muted-foreground/70 size-3.5" aria-hidden="true" />
            </span>
          {/if}
          {#if scheduled.length > 0}
            <ScheduledBadge sends={scheduled} {now} class="ml-auto" />
          {/if}
          {#if running > 0}
            <RunningBadge count={running} class={scheduled.length === 0 ? 'ml-auto' : ''} />
          {/if}
          <time
            class={cn(
              'text-muted-foreground shrink-0 text-[0.6875rem] tabular-nums',
              running === 0 && scheduled.length === 0 && 'ml-auto',
            )}
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
          {#if chat.backFromHold}
            <span
              class="flex shrink-0 items-center gap-1 font-medium text-violet-700 dark:text-violet-300"
            >
              <AlarmClockIcon class="size-3.5" aria-hidden="true" />Back from hold</span
            >
          {:else if yourTurn}
            <!-- The status icon already says it to assistive technology. -->
            <span class="shrink-0 font-medium text-blue-600 dark:text-blue-400" aria-hidden="true"
              >Your turn</span
            >
          {/if}
          {#if onHold}
            <span role="img" class="shrink-0" aria-label="On hold" title="On hold">
              <PauseIcon class="size-3.5" aria-hidden="true" />
            </span>
            {#if chat.holdUntil !== undefined}
              <span class="shrink-0" title={fullTime(chat.holdUntil)}
                >until {formatHoldUntil(chat.holdUntil, now)}</span
              >
            {/if}
            {#if chat.holdNote}
              <span class="text-foreground/80 min-w-0 truncate" title={chat.holdNote}
                >{chat.holdNote}</span
              >
            {:else}
              <span class="min-w-0 truncate">{line}</span>
            {/if}
          {:else}
            <span class={cn('min-w-0 truncate', waiting && 'text-amber-700 dark:text-amber-400')}
              >{line}</span
            >
          {/if}
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
    {#if onMove}
      <ContextMenu.Separator />
      {#if chat.bucket !== 'active'}
        <ContextMenu.Item class="py-1 text-xs" onSelect={() => onMove(chat, 'active')}>
          <InboxIcon /> Make active
        </ContextMenu.Item>
      {/if}
      <ContextMenu.Item class="py-1 text-xs" onSelect={() => onMove(chat, 'onHold')}>
        <PauseIcon /> Put on hold…
      </ContextMenu.Item>
      {#if !archived}
        <ContextMenu.Item class="py-1 text-xs" onSelect={() => onMove(chat, 'archived')}>
          <ArchiveIcon /> Archive
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
