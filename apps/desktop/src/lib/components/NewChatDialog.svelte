<script lang="ts">
  import type { ImageRef, Project } from '@threadgarden/protocol';
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
  import { untrack } from 'svelte';
  import { buildFlags } from '#lib/build-flags.js';
  import Composer from '#lib/components/composer/Composer.svelte';
  import InScope from '#lib/components/InScope.svelte';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { isTauri, pickFolder } from '#lib/native.js';
  import { RequestError } from '#lib/service/client.js';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel, machineNameOf } from '#lib/state/machines.svelte.js';
  import { newChatDraftKey, type ModelChoice } from '#lib/state/interaction.svelte.js';

  /**
   * Starts a chat (spec §5.4): in any listed project or any folder from the
   * native picker, with a model and permission mode (Ruling R11: never
   * bypassPermissions). The first message is written here, with the full
   * composer (`@` files of the chosen folder, `/` commands, images); its draft
   * is kept per folder (`new:<cwd>`).
   *
   * With more than one machine, a Machine select comes first (the machines
   * that are on; the selected project's machine, else This PC, by default):
   * the folders are that machine's projects plus its home folder, the chat
   * starts there and the composer talks to it. The folder picker is This
   * PC's only.
   */
  const { interaction, places, tabs, settings, scopes, machines } = useApp();

  /** Ruling R11: Threadgarden never offers bypassPermissions. */
  const PERMISSION_MODES = [
    { value: 'default', label: 'Default (ask before acting)' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'plan', label: 'Plan' },
    { value: 'auto', label: 'Auto' },
  ];

  const byPinnedThenRecent = (a: Project, b: Project): number =>
    Number(b.pinned) - Number(a.pinned) ||
    b.lastActivity - a.lastActivity ||
    a.displayName.localeCompare(b.displayName);

  const local = scopes.local();
  /** The chosen machine (This PC's id until the dialog opens). */
  let machineId = $state(local.machineId);
  const scope = $derived(scopes.get(machineId) ?? local);
  const onThisPc = $derived(scope === local);
  /** The machines a chat can start on: those that are on and have their stores. */
  const choices = $derived(
    machines.list
      .filter((m) => m.status === 'on' && scopes.get(m.id))
      .map((m) => ({ id: m.id, label: machineLabel(m) })),
  );
  /** A machine a chat can start on now: it has its stores and is on. */
  const usable = (id: string | null | undefined): id is string =>
    !!id && !!scopes.get(id) && machines.get(id)?.status === 'on';
  /**
   * The machine the dialog opens on: the one asked for, else the selected
   * project place's, when it is on; else This PC.
   */
  const startMachine = (): string => {
    const sel = places.selected;
    const want =
      interaction.newChat.machineId ?? (sel.kind === 'project' ? sel.machineId : undefined);
    return usable(want) ? want : local.machineId;
  };

  const projects = $derived(
    scope.places.projects.filter((p) => !p.hidden).sort(byPinnedThenRecent),
  );
  /** Another machine's home folder (its service reports it). */
  const home = $derived(onThisPc ? null : (machines.get(scope.machineId)?.info?.home ?? null));

  let cwd = $state('');
  let picked = $state<string | null>(null);
  let model = $state('');
  let mode = $state('default');
  let models = $state.raw<ModelChoice[]>([]);
  let error = $state<string | null>(null);
  /** Set once a chat was created: focus goes to its composer, not back to the trigger. */
  let created = false;

  /** The folder the dialog was opened with, when it is on the chosen machine. */
  const given = $derived(
    (interaction.newChat.machineId ?? local.machineId) === scope.machineId
      ? interaction.newChat.cwd
      : null,
  );

  const folders = $derived.by(() => {
    const list = projects.map((p) => ({ path: p.path, label: p.displayName }));
    if (home && !list.some((f) => f.path === home)) list.push({ path: home, label: 'Home folder' });
    const extra = [onThisPc ? picked : null, given].filter(
      (p): p is string => !!p && !list.some((f) => f.path === p),
    );
    return [...new Set(extra)].map((p) => ({ path: p, label: p })).concat(list);
  });

  /** The folder a machine starts with: the one given, else its first project, else its home. */
  const firstFolder = (): string => given ?? projects[0]?.path ?? home ?? '';

  let wasOpen = false;
  $effect(() => {
    const open = interaction.newChat.open;
    if (open && !wasOpen) {
      untrack(() => {
        const next = startMachine();
        // A model kept from the last time is only kept on the same machine.
        if (next !== machineId) model = '';
        machineId = next;
        cwd = firstFolder();
      });
      error = null;
      created = false;
    }
    wasOpen = open;
  });

  /**
   * Another machine chosen: its first folder and its own models (a model
   * chosen for one machine is never sent to another).
   */
  const chooseMachine = (id: string): void => {
    machineId = id;
    cwd = firstFolder();
    models = [];
    model = '';
  };

  // The chosen machine was removed while the dialog is open: back to This PC, with its folder.
  $effect(() => {
    if (!interaction.newChat.open || scopes.get(machineId)) return;
    untrack(() => chooseMachine(local.machineId));
  });

  let modelsFor = '';
  $effect(() => {
    if (!interaction.newChat.open || !cwd) return;
    const ask = scope.interaction;
    const at = cwd;
    const key = `${scope.machineId}\n${at}`;
    if (modelsFor === key) return;
    modelsFor = key;
    ask
      .models(at)
      .then((list) => {
        if (cwd === at && scope.interaction === ask) models = list;
      })
      .catch(() => {});
  });

  const modelOptions = $derived(models.filter((m) => m.value !== 'default'));

  const chooseFolder = async (): Promise<void> => {
    const path = await pickFolder();
    if (path) {
      picked = path;
      cwd = path;
    }
  };

  const create = async (text: string, images: ImageRef[]): Promise<boolean> => {
    error = null;
    if (!cwd) {
      error = 'Choose a folder for the chat first.';
      return false;
    }
    const target = scope;
    try {
      const id = await target.chats.create({
        cwd,
        text,
        images,
        ...(model ? { model } : {}),
        ...(mode !== 'default' ? { permissionMode: mode } : {}),
      });
      created = true;
      target.interaction.focusComposer(id);
      tabs.openTab({ machineId: target.machineId, sessionId: id });
      interaction.closeNewChat();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Claude Code went missing: the status refresh brings up the setup screen.
      if (err instanceof RequestError && err.code === 'CLAUDE_MISSING') {
        target.interaction.loadStatus().catch(() => {});
      }
      return false;
    }
  };

  /** `/model` and `/permissions` in the first message open this dialog's pickers (R25). */
  const onControl = (control: 'model' | 'effort' | 'permissionMode'): string | null => {
    if (control === 'effort') {
      return 'Effort can be chosen in the chat header once the chat has started.';
    }
    const id = control === 'model' ? 'new-chat-model' : 'new-chat-mode';
    document.getElementById(id)?.focus();
    return null;
  };

  const selectClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<Dialog.Root
  open={interaction.newChat.open}
  onOpenChange={(open) => {
    if (!open) interaction.closeNewChat();
  }}
>
  <Dialog.Content
    class="gap-4 p-5 sm:max-w-xl"
    onCloseAutoFocus={(e) => {
      if (created) e.preventDefault();
    }}
  >
    <Dialog.Header>
      <Dialog.Title class="text-base">New chat</Dialog.Title>
      <Dialog.Description class="text-xs"
        >Claude Code starts in the folder you choose, with your Claude Code settings.</Dialog.Description
      >
    </Dialog.Header>

    <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
      {#if machines.several}
        <label for="new-chat-machine" class="text-muted-foreground">Machine</label>
        <select
          id="new-chat-machine"
          class={selectClass}
          value={scope.machineId}
          onchange={(e) => chooseMachine(e.currentTarget.value)}
        >
          {#if !choices.some((m) => m.id === scope.machineId)}
            <option value={scope.machineId}>{machineNameOf(machines, scope.machineId)}</option>
          {/if}
          {#each choices as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      {/if}

      <label for="new-chat-folder" class="text-muted-foreground">Folder</label>
      <div class="flex min-w-0 gap-1.5">
        <select id="new-chat-folder" class={selectClass} bind:value={cwd}>
          {#if folders.length === 0}
            <option value="">No projects yet: choose a folder</option>
          {/if}
          {#each folders as f (f.path)}
            <option value={f.path} title={f.path}>{f.label}</option>
          {/each}
        </select>
        <button
          type="button"
          class="hover:bg-muted flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 disabled:opacity-50"
          disabled={!isTauri || !onThisPc}
          title={!onThisPc
            ? 'Only for This PC'
            : isTauri
              ? 'Choose any folder'
              : 'The folder picker needs the desktop app'}
          onclick={() => void chooseFolder()}
        >
          <FolderOpenIcon class="size-4" aria-hidden="true" /> Choose folder…
        </button>
      </div>

      <label for="new-chat-model" class="text-muted-foreground">Model</label>
      <select id="new-chat-model" class={selectClass} bind:value={model}>
        <option value="">Default</option>
        {#each modelOptions as m (m.value)}
          <option value={m.value} title={m.description}>{m.displayName || m.value}</option>
        {/each}
      </select>

      <label for="new-chat-mode" class="text-muted-foreground">Permission mode</label>
      <select id="new-chat-mode" class={selectClass} bind:value={mode}>
        {#each PERMISSION_MODES as m (m.value)}
          <option value={m.value}>{m.label}</option>
        {/each}
      </select>
    </div>

    {#if cwd}
      <p class="text-muted-foreground -mt-1 truncate font-mono text-[0.6875rem]" title={cwd}>
        {cwd}
      </p>
    {/if}

    {#if buildFlags.apiKeyOnly && !settings.hasApiKey}
      <p role="note" class="rounded-md bg-amber-500/15 px-2 py-1.5 text-xs">
        This build of Threadgarden runs chats only on an Anthropic API key. Add your key first.
        <button
          type="button"
          class="underline underline-offset-2"
          onclick={() => (interaction.settingsOpen = true)}>Open settings</button
        >
      </p>
    {/if}

    {#if error}
      <p class="text-destructive text-xs" role="alert">{error}</p>
    {/if}

    {#key `${scope.machineId}\n${cwd}`}
      <InScope {scope}>
        <Composer
          draftKey={newChatDraftKey(cwd)}
          {cwd}
          commandScope={{ cwd }}
          label="First message"
          placeholder="What should Claude do?"
          autofocus
          onSubmit={create}
          {onControl}
        />
      </InScope>
    {/key}
  </Dialog.Content>
</Dialog.Root>
