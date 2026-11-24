<script lang="ts">
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import type { McpScope, McpServer, McpServerConfig } from '@threadgarden/protocol';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
  import { openExternal } from '#lib/native.js';
  import type { ChatMcp } from '#lib/state/mcp.svelte.js';
  import McpAddServerForm from './McpAddServerForm.svelte';
  import {
    ADDED_AFTER_RESTART,
    CLAUDE_AI_CONNECTORS_URL,
    clearAuthLabel,
    menuActions,
    primaryAction,
    REMOVED_AFTER_RESTART,
    removeScope,
    removeText,
    sourceLabel,
    statusLabel,
    TURN_OFF_LABEL,
    type MenuAction,
    type PrimaryAction,
  } from './mcp.js';

  /**
   * "MCP servers (this chat)": a row per server with its source, status, the
   * one action that fits, and a ⋯ menu. A chat that isn't running offers Wake
   * the chat. Sign-in links and pasted addresses are only passed on, never kept.
   */
  let {
    open = $bindable(false),
    mcp,
    live,
    canConfigure,
    remote,
    machineName,
    onWake,
  }: {
    open?: boolean;
    mcp: ChatMcp;
    live: boolean;
    /** The machine can add and remove servers through Claude Code (`mcp-config`). */
    canConfigure: boolean;
    /** The chat's machine isn't this PC: the browser can't reach its sign-in callback. */
    remote: boolean;
    machineName: string;
    onWake: () => Promise<void>;
  } = $props();

  const servers = $derived(mcp.state?.servers ?? []);

  /** Why an action failed, by server name (Claude Code's own words). */
  let errors = $state<Record<string, string>>({});
  /** The server whose sign-in waits for its pasted address (remote machines). */
  let pasting = $state<string | null>(null);
  let pasted = $state('');
  /** The server whose browser sign-in on This PC is under way: "I've signed in" reconnects it. */
  let finishing = $state<string | null>(null);
  /** "I've signed in" was clicked for `finishing`: if it falls back to Needs sign-in, say so. */
  let tried = $state(false);
  let busy = $state<string | null>(null);
  let wakeError = $state<string | null>(null);
  /** The Add MCP server form replaces the list. */
  let adding = $state(false);
  /** The restart lines: shown while a change waits for the chat to restart. */
  let addedPending = $state(false);
  let removedPending = $state(false);
  /** The server a Remove confirmation is about. */
  let removing = $state<{ name: string; scope: McpScope } | null>(null);
  let removeOpen = $state(false);

  $effect(() => {
    if (!open || !live) return;
    void mcp.load().catch(() => {});
    return mcp.startPolling();
  });

  $effect(() => {
    // The paste field belongs to a sign-in that is still waiting.
    const waiting = mcp.state?.servers.find((s) => s.name === pasting)?.status === 'needs-auth';
    if (pasting !== null && !waiting) {
      pasting = null;
      pasted = '';
    }
  });

  $effect(() => {
    // The "I've signed in" line belongs to a sign-in that is still waiting.
    // It stays through Connecting…, which may fall back to Needs sign-in.
    const status = mcp.state?.servers.find((s) => s.name === finishing)?.status;
    if (finishing !== null && status !== 'needs-auth' && status !== 'pending') {
      finishing = null;
      tried = false;
    }
  });

  $effect(() => {
    if (open) return;
    errors = {};
    pasting = null;
    finishing = null;
    tried = false;
    pasted = '';
    wakeError = null;
    adding = false;
    addedPending = false;
    removedPending = false;
    removing = null;
    removeOpen = false;
  });

  const run = async (name: string, f: () => Promise<void>): Promise<void> => {
    busy = name;
    const rest = { ...errors };
    delete rest[name];
    errors = rest;
    try {
      await f();
    } catch (err) {
      errors = { ...errors, [name]: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  };

  const signIn = (name: string): Promise<void> =>
    run(name, async () => {
      const url = await mcp.signIn(name);
      if (url) await openExternal(url);
      if (url && remote) {
        pasting = name;
        pasted = '';
      } else if (url) {
        finishing = name;
        tried = false;
      }
    });

  const finish = (name: string): Promise<void> =>
    run(name, async () => {
      await mcp.submitCallback(name, pasted.trim(), () => {
        pasting = null;
        pasted = '';
      });
    });

  const primary = (s: McpServer, a: PrimaryAction): Promise<void> => {
    switch (a) {
      case 'approve':
        return run(s.name, () => mcp.approve(s.name));
      case 'signIn':
        return signIn(s.name);
      case 'claudeAiSignIn':
        return run(s.name, async () => void (await openExternal(CLAUDE_AI_CONNECTORS_URL)));
      case 'reconnect':
        return run(s.name, () => mcp.act(s.name, 'reconnect'));
      case 'turnOn':
        return run(s.name, () => mcp.act(s.name, 'enable'));
    }
  };

  const PRIMARY_LABEL: Record<PrimaryAction, string> = {
    approve: 'Approve',
    signIn: 'Sign in',
    claudeAiSignIn: 'Sign in',
    reconnect: 'Reconnect',
    turnOn: 'Turn on',
  };

  const add = async (name: string, scope: McpScope, config: McpServerConfig): Promise<void> => {
    const { restartPending } = await mcp.add(name, scope, config);
    if (restartPending) addedPending = true;
    adding = false;
  };

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return;
    const { restartPending } = await mcp.remove(removing.name, removing.scope);
    if (restartPending) removedPending = true;
  };

  const menuItems = (s: McpServer): MenuAction[] => [
    ...menuActions(s),
    ...(canConfigure && removeScope(s) ? (['remove'] as const) : []),
  ];

  const menu = (s: McpServer, a: MenuAction): Promise<void> => {
    if (a === 'remove') {
      const scope = removeScope(s);
      if (scope) {
        removing = { name: s.name, scope };
        removeOpen = true;
      }
      return Promise.resolve();
    }
    return run(s.name, () =>
      mcp.act(s.name, a === 'turnOff' ? 'disable' : a === 'clearAuth' ? 'clearAuth' : 'reconnect'),
    );
  };

  const menuLabel = (a: MenuAction): string =>
    a === 'reconnect'
      ? 'Reconnect'
      : a === 'turnOff'
        ? TURN_OFF_LABEL
        : a === 'remove'
          ? 'Remove'
          : clearAuthLabel(machineName);

  const wake = async (): Promise<void> => {
    wakeError = null;
    busy = '';
    try {
      await onWake();
    } catch (err) {
      wakeError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = null;
    }
  };
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="gap-4 p-5 sm:max-w-lg">
    <Dialog.Header>
      <div class="flex items-center gap-2">
        <Dialog.Title class="text-base">MCP servers (this chat)</Dialog.Title>
        {#if canConfigure && live && !adding}
          <Button
            size="sm"
            variant="outline"
            class="ml-auto"
            disabled={busy !== null}
            onclick={() => (adding = true)}>+ Add server</Button
          >
        {/if}
      </div>
      <Dialog.Description class="sr-only">The MCP servers this chat can use.</Dialog.Description>
    </Dialog.Header>

    {#if !live}
      <p class="text-muted-foreground text-sm">
        This chat isn't running. Wake it to see its MCP servers.
      </p>
      {#if wakeError}<p class="text-destructive text-sm" role="alert">{wakeError}</p>{/if}
      <div>
        <Button size="sm" disabled={busy !== null} onclick={wake}>Wake the chat</Button>
      </div>
    {:else if adding}
      <McpAddServerForm onAdd={add} onCancel={() => (adding = false)} />
    {:else}
      {#if addedPending}
        <p class="text-muted-foreground text-sm">{ADDED_AFTER_RESTART}</p>
      {/if}
      {#if removedPending}
        <p class="text-muted-foreground text-sm">{REMOVED_AFTER_RESTART}</p>
      {/if}
      {#if servers.length === 0}
        <p class="text-muted-foreground text-sm">No MCP servers.</p>
      {:else}
        <ul class="flex max-h-96 flex-col gap-3 overflow-y-auto">
          {#each servers as s (s.name)}
            {@const a = primaryAction(s)}
            {@const items = menuItems(s)}
            <li class="flex flex-col gap-1" data-testid="mcp-row">
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span class="truncate text-sm font-medium">{s.name}</span>
                    <span class="text-muted-foreground text-xs">{sourceLabel(s.source)}</span>
                  </div>
                  <div class="text-muted-foreground text-xs break-words">{statusLabel(s)}</div>
                </div>
                {#if a}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onclick={() => primary(s, a)}>{PRIMARY_LABEL[a]}</Button
                  >
                {/if}
                {#if items.length > 0}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button
                          {...props}
                          variant="ghost"
                          size="icon-xs"
                          aria-label="More for {s.name}"
                          disabled={busy !== null}
                        >
                          <EllipsisIcon />
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end" class="min-w-40">
                      {#each items as m (m)}
                        <DropdownMenu.Item class="py-1 text-xs" onSelect={() => menu(s, m)}>
                          {menuLabel(m)}
                        </DropdownMenu.Item>
                      {/each}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                {/if}
              </div>
              {#if pasting === s.name && s.status === 'needs-auth'}
                <label class="flex flex-col gap-1 text-xs">
                  Paste the address from your browser's address bar
                  <input
                    class="bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm"
                    bind:value={pasted}
                  />
                </label>
                <div>
                  <Button
                    size="sm"
                    disabled={busy !== null || pasted.trim() === ''}
                    onclick={() => finish(s.name)}>Finish sign-in</Button
                  >
                </div>
              {/if}
              {#if finishing === s.name}
                <div class="flex items-center gap-2 text-xs">
                  <span>Finish signing in in your browser, then:</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onclick={() => {
                      tried = true;
                      void run(s.name, () => mcp.act(s.name, 'reconnect'));
                    }}>I've signed in</Button
                  >
                </div>
                {#if tried && s.status === 'needs-auth' && busy === null}
                  <p class="text-muted-foreground text-xs">
                    Not signed in yet — finish in your browser, then try again.
                  </p>
                {/if}
              {/if}
              {#if errors[s.name]}
                <p class="text-destructive text-xs break-words" role="alert">{errors[s.name]}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={removeOpen}
  title={`Remove ${removing?.name ?? ''}?`}
  description={removing ? removeText(machineName, removing.scope) : undefined}
  confirmLabel="Remove"
  destructive
  onConfirm={confirmRemove}
/>
