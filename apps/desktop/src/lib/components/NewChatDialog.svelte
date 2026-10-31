<script lang="ts">
  import type { ImageRef, Project } from '@threadgarden/protocol';
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
  import { buildFlags } from '#lib/build-flags.js';
  import Composer from '#lib/components/composer/Composer.svelte';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { isTauri, pickFolder } from '#lib/native.js';
  import { RequestError } from '#lib/service/client.js';
  import { useApp } from '#lib/state/context.js';
  import { newChatDraftKey, type ModelChoice } from '#lib/state/interaction.svelte.js';

  /**
   * Starts a chat (spec §5.4): in any listed project or any folder from the
   * native picker, with a model and permission mode (Ruling R11: never
   * bypassPermissions). The first message is written here, with the full
   * composer (`@` files of the chosen folder, `/` commands, images); its draft
   * is kept per folder (`new:<cwd>`).
   */
  const { interaction, places, chats, tabs, settings } = useApp();

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

  const projects = $derived(places.projects.filter((p) => !p.hidden).sort(byPinnedThenRecent));

  let cwd = $state('');
  let picked = $state<string | null>(null);
  let model = $state('');
  let mode = $state('default');
  let models = $state.raw<ModelChoice[]>([]);
  let error = $state<string | null>(null);
  /** Set once a chat was created: focus goes to its composer, not back to the trigger. */
  let created = false;

  const folders = $derived.by(() => {
    const list = projects.map((p) => ({ path: p.path, label: p.displayName }));
    const extra = [picked, interaction.newChat.cwd].filter(
      (p): p is string => !!p && !list.some((f) => f.path === p),
    );
    return [...new Set(extra)].map((p) => ({ path: p, label: p })).concat(list);
  });

  let wasOpen = false;
  $effect(() => {
    const open = interaction.newChat.open;
    if (open && !wasOpen) {
      cwd = interaction.newChat.cwd ?? projects[0]?.path ?? '';
      error = null;
      created = false;
    }
    wasOpen = open;
  });

  let modelsFor = '';
  $effect(() => {
    if (!interaction.newChat.open || !cwd || modelsFor === cwd) return;
    const at = cwd;
    modelsFor = at;
    interaction
      .models(at)
      .then((list) => {
        if (cwd === at) models = list;
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
    try {
      const id = await chats.create({
        cwd,
        text,
        images,
        ...(model ? { model } : {}),
        ...(mode !== 'default' ? { permissionMode: mode } : {}),
      });
      created = true;
      interaction.focusComposer(id);
      tabs.openTab(id);
      interaction.closeNewChat();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Claude Code went missing: the status refresh brings up the setup screen.
      if (err instanceof RequestError && err.code === 'CLAUDE_MISSING') {
        interaction.loadStatus().catch(() => {});
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
          disabled={!isTauri}
          title={isTauri ? 'Choose any folder' : 'The folder picker needs the desktop app'}
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

    {#key cwd}
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
    {/key}
  </Dialog.Content>
</Dialog.Root>
