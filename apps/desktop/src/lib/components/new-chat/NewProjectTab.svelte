<script lang="ts">
  import type { GithubStatus } from '@threadgarden/protocol';
  import { onMount } from 'svelte';
  import { pickFolder } from '#lib/native.js';
  import { nameProblem, type ProjectsApi } from '#lib/projects.js';
  import CreateInField from './CreateInField.svelte';
  import FolderBrowser from './FolderBrowser.svelte';

  /**
   * New chat's New project tab: the project's name, where it goes (the
   * machine's remembered Create in, fetched each time the tab opens) and
   * whether it gets a private GitHub repo. The dialog creates it on send.
   */
  let {
    name = $bindable(),
    createIn = $bindable(),
    github = $bindable(),
    api,
    onThisPc,
    machineName,
    platform,
    home,
  }: {
    name: string;
    createIn: string;
    github: boolean;
    /** The chosen machine's projects methods. */
    api: ProjectsApi;
    onThisPc: boolean;
    machineName: string;
    /** The machine's `info.platform`, for the preview's separator. */
    platform: string | undefined;
    home: string | null;
  } = $props();

  let gh = $state<GithubStatus | null>(null);
  let browsing = $state(false);

  const problem = $derived(name ? nameProblem(name) : null);
  /** Ruling P3: display only, never sent; the service builds the real path. */
  const preview = $derived.by(() => {
    if (!name || !createIn) return null;
    const sep = platform === 'win32' ? '\\' : '/';
    return `→ ${createIn.replace(/[\\/]+$/, '')}${sep}${name}`;
  });

  onMount(() => {
    const before = createIn;
    api
      .createIn()
      .then((path) => {
        // A place typed meanwhile wins.
        if (createIn === before) createIn = path;
      })
      .catch(() => {});
    api
      .githubStatus()
      .then((status) => (gh = status))
      .catch((e: unknown) => {
        gh = { ready: false, login: null, problem: e instanceof Error ? e.message : String(e) };
      });
  });

  $effect(() => {
    if (gh && !gh.ready) github = false;
  });

  const browse = async (): Promise<void> => {
    if (!onThisPc) {
      browsing = true;
      return;
    }
    const path = await pickFolder();
    if (path) createIn = path;
  };
</script>

<div class="grid gap-2 text-xs">
  <div class="grid gap-1">
    <label for="new-project-name" class="text-muted-foreground">Name</label>
    <input
      id="new-project-name"
      class="bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm"
      spellcheck="false"
      autocomplete="off"
      aria-invalid={!!problem}
      aria-describedby={problem ? 'new-project-name-problem' : undefined}
      bind:value={name}
    />
    {#if problem}
      <p id="new-project-name-problem" class="text-destructive">{problem}</p>
    {/if}
  </div>

  <CreateInField value={createIn} onChange={(v) => (createIn = v)} browse={() => void browse()} />

  <label class="flex w-fit items-center gap-2">
    <input
      type="checkbox"
      bind:checked={github}
      disabled={!gh?.ready}
      title={gh && !gh.ready ? (gh.problem ?? undefined) : undefined}
    />
    Create a GitHub repo <span class="text-muted-foreground">(private)</span>
  </label>

  {#if preview}
    <p class="text-muted-foreground truncate font-mono text-[0.6875rem]" title={preview}>
      {preview}
    </p>
  {/if}
</div>

{#if browsing}
  <FolderBrowser
    {api}
    {machineName}
    start={createIn || home || '~'}
    onPick={(path) => {
      browsing = false;
      createIn = path;
    }}
    onCancel={() => (browsing = false)}
  />
{/if}
