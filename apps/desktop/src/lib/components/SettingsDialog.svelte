<script lang="ts">
  import type { Settings, SettingsPatch } from '@pahub/protocol';
  import FileSearchIcon from '@lucide/svelte/icons/file-search';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import { buildFlags } from '#lib/build-flags.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { isTauri, pickFile, setAutostart } from '#lib/native.js';
  import { useApp } from '#lib/state/context.js';
  import { SCALES } from '#lib/interface-scale.js';
  import { formatShortcut, shortcut } from '#lib/shortcuts.js';
  import { IDLE_MINUTES_MAX } from '#lib/state/settings.svelte.js';

  /**
   * pahub's own settings (spec §6.5), stored by the service (the API key
   * excepted: it lives in the OS credential store, spec §5.5), plus read-only
   * facts: where Claude Code was found, whether external sessions are
   * available (spec §6.3) and the history indexing progress.
   */
  const { settings, interaction, connection } = useApp();

  type Form = Omit<Settings, 'claudePath' | 'idleReclaimMinutes'> & {
    claudePath: string;
    idleReclaimMinutes: string;
  };

  const fromSettings = (s: Settings): Form => ({
    ...s,
    claudePath: s.claudePath ?? '',
    idleReclaimMinutes: String(s.idleReclaimMinutes),
  });

  let form = $state<Form>(fromSettings(settings.value));
  let saving = $state(false);
  let error = $state<string | null>(null);
  let keyInput = $state('');
  let keyBusy = $state(false);
  let keyError = $state<string | null>(null);

  let wasOpen = false;
  $effect(() => {
    const open = interaction.settingsOpen;
    if (open && !wasOpen) {
      form = fromSettings(settings.value);
      error = null;
      keyInput = '';
      keyError = null;
      interaction.loadStatus().catch(() => {});
      settings.checkApiKey().catch(() => {});
    }
    wasOpen = open;
  });

  const idle = $derived.by(() => {
    const text = form.idleReclaimMinutes.trim();
    const n = Number(text);
    return /^\d+$/.test(text) && n <= IDLE_MINUTES_MAX ? n : null;
  });

  const close = (): void => {
    interaction.settingsOpen = false;
  };

  /** The shortcuts dialog replaces this one (one modal at a time). */
  const showShortcuts = (): void => {
    close();
    interaction.shortcutsOpen = true;
  };

  const scaleUp = formatShortcut(shortcut('scale-up').combos[0]!);
  const scaleDown = formatShortcut(shortcut('scale-down').combos[0]!);

  const save = async (): Promise<void> => {
    if (idle === null) return;
    const next: Settings = {
      ...form,
      claudePath: form.claudePath.trim() || null,
      idleReclaimMinutes: idle,
    };
    const patch: SettingsPatch = {};
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      if (next[key] !== settings.value[key]) Object.assign(patch, { [key]: next[key] });
    }
    saving = true;
    error = null;
    try {
      if (patch.startOnLogin !== undefined) await setAutostart(patch.startOnLogin);
      if (Object.keys(patch).length > 0) await settings.update(patch);
      // The service looks for Claude Code again at the new path.
      if ('claudePath' in patch) interaction.loadStatus().catch(() => {});
      close();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  };

  const browse = async (): Promise<void> => {
    const path = await pickFile();
    if (path) form.claudePath = path;
  };

  const keyAction = async (action: () => Promise<void>): Promise<void> => {
    keyBusy = true;
    keyError = null;
    try {
      await action();
      keyInput = '';
    } catch (err) {
      keyError = err instanceof Error ? err.message : String(err);
    } finally {
      keyBusy = false;
    }
  };

  const status = $derived(interaction.status);
  const indexing = $derived(connection.indexing ?? status?.indexing ?? null);

  const fieldClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
  const checkClass = 'flex items-center gap-2 text-sm';
</script>

<Dialog.Root
  open={interaction.settingsOpen}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="max-h-[90vh] gap-4 overflow-y-auto p-5 sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="text-base">Settings</Dialog.Title>
      <Dialog.Description class="text-xs"
        >pahub's own settings. Works with Claude Code.</Dialog.Description
      >
    </Dialog.Header>

    <section class="grid gap-3" aria-label="General">
      <div class="grid gap-1">
        <label for="settings-claude-path" class="text-muted-foreground text-xs"
          >Claude Code executable</label
        >
        <div class="flex gap-1.5">
          <input
            id="settings-claude-path"
            class="{fieldClass} font-mono text-xs"
            placeholder="Found automatically"
            spellcheck="false"
            autocomplete="off"
            bind:value={form.claudePath}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!isTauri}
            title={isTauri
              ? 'Choose the claude executable'
              : 'The file picker needs the desktop app'}
            onclick={() => void browse()}
          >
            <FileSearchIcon aria-hidden="true" /> Browse…
          </Button>
        </div>
      </div>

      <div class="grid gap-1">
        <label for="settings-idle" class="text-muted-foreground text-xs"
          >Close idle chats after (minutes; 0 keeps them open)</label
        >
        <input
          id="settings-idle"
          class="{fieldClass} w-28"
          inputmode="numeric"
          aria-invalid={idle === null}
          aria-describedby={idle === null ? 'settings-idle-error' : undefined}
          bind:value={form.idleReclaimMinutes}
        />
        {#if idle === null}
          <p id="settings-idle-error" class="text-destructive text-xs">
            Enter a whole number from 0 to {IDLE_MINUTES_MAX}.
          </p>
        {/if}
      </div>

      <div class="grid gap-1">
        <label for="settings-theme" class="text-muted-foreground text-xs">Theme</label>
        <select id="settings-theme" class="{fieldClass} w-40" bind:value={form.theme}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div class="grid gap-1">
        <label for="settings-scale" class="text-muted-foreground text-xs"
          >Interface size (applies at once; also {scaleUp} and {scaleDown})</label
        >
        <select
          id="settings-scale"
          class="{fieldClass} w-40"
          value={String(settings.scale)}
          onchange={(e) => settings.setScale(Number(e.currentTarget.value))}
        >
          {#each SCALES as s (s)}
            <option value={String(s)}>{Math.round(s * 100)} %{s === 1 ? ' (default)' : ''}</option>
          {/each}
        </select>
      </div>

      <label class={checkClass}>
        <input type="checkbox" bind:checked={form.notifications} /> Notifications when a chat needs you
      </label>
      <label class={checkClass}>
        <input type="checkbox" bind:checked={form.notifyOnFinish} /> Notify when a chat finishes
      </label>
      <label class={checkClass}>
        <input type="checkbox" bind:checked={form.enterToSend} /> Enter sends the message (Shift+Enter
        for a new line)
      </label>
      <label class={checkClass}>
        <input type="checkbox" bind:checked={form.externalPolling} /> Show sessions running outside pahub
      </label>
      <label class={checkClass}>
        <input type="checkbox" bind:checked={form.startOnLogin} /> Start on login
      </label>
    </section>

    <section class="grid gap-1 border-t pt-3" aria-label="Authentication">
      <label for="settings-api-key" class="text-muted-foreground text-xs">Anthropic API key</label>
      <div class="flex gap-1.5">
        <input
          id="settings-api-key"
          type="password"
          class="{fieldClass} font-mono text-xs"
          autocomplete="off"
          spellcheck="false"
          placeholder={settings.hasApiKey ? 'Stored — enter a new key to replace it' : 'sk-ant-…'}
          bind:value={keyInput}
        />
        <Button
          size="sm"
          disabled={keyBusy || !keyInput.trim()}
          onclick={() => void keyAction(() => settings.saveApiKey(keyInput))}>Save key</Button
        >
        {#if settings.hasApiKey}
          <Button
            variant="outline"
            size="sm"
            disabled={keyBusy}
            onclick={() => void keyAction(settings.removeApiKey)}>Remove key</Button
          >
        {/if}
      </div>
      <p class="text-muted-foreground text-xs">
        {#if settings.hasApiKey}
          A key is stored in the OS credential store; chats pahub starts use API billing.
        {:else if buildFlags.apiKeyOnly}
          This build of pahub runs chats only on an Anthropic API key (API billing). Add your key to
          start or continue chats; history stays browsable without one.
        {:else}
          No key: chats use the sign-in of your Claude Code installation.
        {/if}
      </p>
      {#if keyError}
        <p class="text-destructive text-xs" role="alert">{keyError}</p>
      {/if}
    </section>

    <section class="grid gap-1 border-t pt-3 text-xs" aria-label="System">
      <h3 class="text-muted-foreground font-medium">System</h3>
      {#if !status}
        <p class="text-muted-foreground">Checking…</p>
      {:else}
        {#if status.claude.found}
          <p>
            Claude Code: <span class="font-mono">{status.claude.path ?? 'found'}</span>
            {#if status.claude.version}<span class="text-muted-foreground"
                >version {status.claude.version}</span
              >{/if}
          </p>
        {:else}
          <p class="text-destructive">
            Claude Code was not found{status.claude.problem ? `: ${status.claude.problem}` : '.'}
          </p>
        {/if}
        <p class={status.externalAvailable ? '' : 'text-muted-foreground'}>
          {status.externalAvailable
            ? 'External sessions (terminal, background) are shown.'
            : 'External sessions are unavailable: `claude agents` is missing, failed, or agent view is disabled.'}
        </p>
        <p class="text-muted-foreground">
          {#if indexing && indexing.done < indexing.total}
            Indexing history: {indexing.done} of {indexing.total} sessions
          {:else}
            History index is up to date.
          {/if}
        </p>
      {/if}
    </section>

    {#if error}
      <p class="text-destructive text-xs" role="alert">{error}</p>
    {/if}

    <Dialog.Footer class="sm:justify-between">
      <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={showShortcuts}>
        <KeyboardIcon aria-hidden="true" /> Keyboard shortcuts…
      </Button>
      <div class="flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="outline" size="sm" onclick={close}>Cancel</Button>
        <Button size="sm" disabled={saving || idle === null} onclick={() => void save()}
          >Save</Button
        >
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
