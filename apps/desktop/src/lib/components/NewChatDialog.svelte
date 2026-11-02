<script lang="ts">
  import type { ImageRef, Project, Result } from '@threadgarden/protocol';
  import { untrack } from 'svelte';
  import { buildFlags } from '#lib/build-flags.js';
  import Composer from '#lib/components/composer/Composer.svelte';
  import InScope from '#lib/components/InScope.svelte';
  import ExistingFolderTab from '#lib/components/new-chat/ExistingFolderTab.svelte';
  import NewProjectTab from '#lib/components/new-chat/NewProjectTab.svelte';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { nameProblem, projectsApi, supportsProjects } from '#lib/projects.js';
  import { RequestError } from '#lib/service/client.js';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel, machineNameOf } from '#lib/state/machines.svelte.js';
  import { newChatDraftKey, type ModelChoice } from '#lib/state/interaction.svelte.js';
  import type { MachineScope } from '#lib/state/scope.js';

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
   * starts there and the composer talks to it.
   *
   * Tabs under it say what is starting: an Existing folder, a New project
   * (made first, then the chat starts in it) or a Clone. Model, Permission
   * mode and the composer are shared by all three; this dialog keeps the
   * tab and sends by it. A machine whose service predates projects offers
   * only Existing folder, without Browse….
   */
  const { interaction, places, tabs, settings, scopes, machines, power } = useApp();

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

  type Tab = 'existing' | 'new' | 'clone';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'existing', label: 'Existing folder' },
    { id: 'new', label: 'New project' },
    { id: 'clone', label: 'Clone' },
  ];

  const local = scopes.local();
  /** The chosen machine (This PC's id until the dialog opens). */
  let machineId = $state(local.machineId);
  const scope = $derived(scopes.get(machineId) ?? local);
  const onThisPc = $derived(scope === local);
  /**
   * The machines a chat can start on: those that are on, not checking or
   * shutting down (`power.takesWork`), and have their stores.
   */
  const choices = $derived(
    machines.list
      .filter((m) => m.status === 'on' && power.takesWork(m.id) && scopes.get(m.id))
      .map((m) => ({ id: m.id, label: machineLabel(m) })),
  );
  /** A machine a chat can start on now: it has its stores and takes work. */
  const usable = (id: string | null | undefined): id is string =>
    !!id && !!scopes.get(id) && machines.get(id)?.status === 'on' && power.takesWork(id);
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

  let tab = $state<Tab>('existing');
  /** This PC always can (its service is the app's own version). */
  const supported = $derived(onThisPc || supportsProjects(machines.get(scope.machineId)));
  const machineName = $derived(machineNameOf(machines, scope.machineId));
  const updateHint = $derived(supported ? null : `Update ${machineName} to use this`);
  const projectsOf = $derived(projectsApi(scope.api));

  let cwd = $state('');
  /** A folder chosen with Browse…, on the machine it was chosen on. */
  let picked = $state<{ machineId: string; path: string } | null>(null);
  let name = $state('');
  let createIn = $state('');
  let github = $state(false);
  /** A project made whose chat did not start, with the message meant for it (Start there). */
  let made = $state<{ path: string; text: string } | null>(null);
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
    const mine = picked?.machineId === scope.machineId ? picked.path : null;
    const extra = [mine, given].filter((p): p is string => !!p && !list.some((f) => f.path === p));
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
      tab = 'existing';
      name = '';
      github = false;
      error = null;
      made = null;
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
    createIn = '';
    made = null;
    models = [];
    model = '';
  };

  // A machine that can't make projects offers only Existing folder.
  $effect(() => {
    if (!supported && tab !== 'existing') tab = 'existing';
  });

  // The chosen machine was removed while the dialog is open: back to This PC, with its folder.
  $effect(() => {
    if (!interaction.newChat.open || scopes.get(machineId)) return;
    untrack(() => chooseMachine(local.machineId));
  });

  /** The folder the models are asked for: the chosen one, else where a new project goes. */
  const modelsAt = $derived(cwd || createIn);
  let modelsFor = '';
  $effect(() => {
    if (!interaction.newChat.open || !modelsAt) return;
    const ask = scope.interaction;
    const at = modelsAt;
    const key = `${scope.machineId}\n${at}`;
    if (modelsFor === key) return;
    modelsFor = key;
    ask
      .models(at)
      .then((list) => {
        if (modelsAt === at && scope.interaction === ask) models = list;
      })
      .catch(() => {});
  });

  const modelOptions = $derived(models.filter((m) => m.value !== 'default'));

  /** A folder chosen with Browse… (or a made project) joins the list, selected. */
  const pickFolder = (path: string): void => {
    picked = { machineId: scope.machineId, path };
    cwd = path;
  };

  /** The New project tab's draft (its folder does not exist yet). */
  const projectDraftKey = $derived(`new:project:${scope.machineId}`);
  const draftKey = $derived(tab === 'new' ? projectDraftKey : newChatDraftKey(cwd));
  const composerCwd = $derived(tab === 'new' ? createIn : cwd);

  /** Starts the chat in `at` on `target` and opens it; throws what `chats.create` throws. */
  const startChat = async (
    target: MachineScope,
    at: string,
    text: string,
    images: ImageRef[],
  ): Promise<void> => {
    const id = await target.chats.create({
      cwd: at,
      text,
      images,
      ...(model ? { model } : {}),
      ...(mode !== 'default' ? { permissionMode: mode } : {}),
    });
    created = true;
    target.interaction.focusComposer(id);
    tabs.openTab({ machineId: target.machineId, sessionId: id });
    interaction.closeNewChat();
  };

  /** What went wrong, to show; Claude Code gone missing also brings up the setup screen. */
  const reason = (target: MachineScope, err: unknown): string => {
    if (err instanceof RequestError && err.code === 'CLAUDE_MISSING') {
      target.interaction.loadStatus().catch(() => {});
    }
    return err instanceof Error ? err.message : String(err);
  };

  const startInFolder = async (text: string, images: ImageRef[]): Promise<boolean> => {
    if (!cwd) {
      error = 'Choose a folder for the chat first.';
      return false;
    }
    const target = scope;
    try {
      await startChat(target, cwd, text, images);
      return true;
    } catch (err) {
      error = reason(target, err);
      return false;
    }
  };

  /** Makes the project, then starts the chat in it. A made project stays whatever follows. */
  const startProject = async (text: string, images: ImageRef[]): Promise<boolean> => {
    // The hint under the name already says what is wrong with it.
    if (nameProblem(name)) return false;
    if (!name || !createIn) {
      error = name ? 'Choose where to create the project first.' : 'Name the project first.';
      return false;
    }
    const target = scope;
    const called = name;
    let result: Result<'projects.create'>;
    try {
      result = await projectsApi(target.api).create({ createIn, name: called, github });
    } catch (err) {
      error = reason(target, err);
      return false;
    }
    const halfway = (why: string): false => {
      error = `${called} was created, but the chat didn't start: ${why}`;
      made = { path: result.path, text };
      return false;
    };
    if (result.problem) return halfway(result.problem);
    try {
      await startChat(target, result.path, text, images);
      return true;
    } catch (err) {
      return halfway(reason(target, err));
    }
  };

  /** Start there: the made project selected in Existing folder, the message moved to its draft. */
  const startThere = (): void => {
    if (!made) return;
    scope.interaction.saveDraft(newChatDraftKey(made.path), made.text);
    scope.interaction.clearDraft(projectDraftKey);
    pickFolder(made.path);
    tab = 'existing';
    made = null;
    error = null;
  };

  /** Sends the first message the way the open tab starts a chat. */
  const create = async (text: string, images: ImageRef[]): Promise<boolean> => {
    error = null;
    made = null;
    if (tab === 'new') return startProject(text, images);
    if (tab === 'clone') return false;
    return startInFolder(text, images);
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

    {#if machines.several}
      <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
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
      </div>
    {/if}

    <div role="tablist" aria-label="Start from" class="-mb-2 flex gap-1 border-b text-xs">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          id="new-chat-tab-{t.id}"
          aria-selected={tab === t.id}
          aria-controls="new-chat-panel"
          disabled={t.id !== 'existing' && !supported}
          title={t.id === 'existing' ? undefined : (updateHint ?? undefined)}
          class="-mb-px border-b-2 px-2.5 py-1.5 disabled:opacity-50 {tab === t.id
            ? 'border-primary text-foreground'
            : 'text-muted-foreground hover:text-foreground border-transparent'}"
          onclick={() => (tab = t.id)}>{t.label}</button
        >
      {/each}
    </div>

    <div
      id="new-chat-panel"
      role="tabpanel"
      aria-labelledby="new-chat-tab-{tab}"
      class="grid gap-2"
    >
      {#if tab === 'existing'}
        <ExistingFolderTab
          {folders}
          bind:cwd
          {onThisPc}
          api={projectsOf}
          {machineName}
          {home}
          blocked={updateHint}
          onPick={pickFolder}
        />
      {:else if tab === 'new'}
        {#key scope.machineId}
          <NewProjectTab
            bind:name
            bind:createIn
            bind:github
            api={projectsOf}
            {onThisPc}
            {machineName}
            platform={machines.get(scope.machineId)?.info?.platform}
            {home}
          />
        {/key}
      {/if}
    </div>

    <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
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
      <p class="text-destructive text-xs" role="alert">
        {error}
        {#if made}
          <button type="button" class="underline underline-offset-2" onclick={startThere}
            >Start there</button
          >
        {/if}
      </p>
    {/if}

    {#key `${scope.machineId}\n${draftKey}`}
      <InScope {scope}>
        <Composer
          {draftKey}
          cwd={composerCwd}
          commandScope={{ cwd: composerCwd }}
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
