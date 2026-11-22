<script lang="ts">
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import type { McpServer } from '@threadgarden/protocol';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
  import { openExternal } from '#lib/native.js';
  import type { ChatMcp } from '#lib/state/mcp.svelte.js';
  import {
    CLAUDE_AI_CONNECTORS_URL,
    clearAuthLabel,
    menuActions,
    primaryAction,
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
    remote,
    machineName,
    onWake,
  }: {
    open?: boolean;
    mcp: ChatMcp;
    live: boolean;
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
  let busy = $state<string | null>(null);
  let wakeError = $state<string | null>(null);

  $effect(() => {
    if (!open || !live) return;
    void mcp.load().catch(() => {});
    return mcp.startPolling();
  });

  $effect(() => {
    if (open) return;
    errors = {};
    pasting = null;
    pasted = '';
    wakeError = null;
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
      }
    });

  const finish = (name: string): Promise<void> =>
    run(name, async () => {
      await mcp.submitCallback(name, pasted.trim());
      pasting = null;
      pasted = '';
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

  const menu = (s: McpServer, a: MenuAction): Promise<void> =>
    run(s.name, () =>
      mcp.act(s.name, a === 'turnOff' ? 'disable' : a === 'clearAuth' ? 'clearAuth' : 'reconnect'),
    );

  const menuLabel = (a: MenuAction): string =>
    a === 'reconnect'
      ? 'Reconnect'
      : a === 'turnOff'
        ? TURN_OFF_LABEL
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
      <Dialog.Title class="text-base">MCP servers (this chat)</Dialog.Title>
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
    {:else if servers.length === 0}
      <p class="text-muted-foreground text-sm">No MCP servers.</p>
    {:else}
      <ul class="flex max-h-96 flex-col gap-3 overflow-y-auto">
        {#each servers as s (s.name)}
          {@const a = primaryAction(s)}
          {@const items = menuActions(s)}
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
            {#if pasting === s.name}
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
            {#if errors[s.name]}
              <p class="text-destructive text-xs break-words" role="alert">{errors[s.name]}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </Dialog.Content>
</Dialog.Root>
