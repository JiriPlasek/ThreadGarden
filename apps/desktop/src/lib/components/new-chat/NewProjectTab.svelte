<script lang="ts">
  import type { GithubStatus } from '@threadgarden/protocol';
  import { onMount } from 'svelte';
  import { nameProblem, type ProjectsApi } from '#lib/projects.js';
  import CreateInField from './CreateInField.svelte';
  import { errorText } from './start.js';

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

  const problem = $derived(name ? nameProblem(name) : null);
  /** Ruling P3: display only, never sent; the service builds the real path. */
  const preview = $derived.by(() => {
    if (!name || !createIn) return null;
    const sep = platform === 'win32' ? '\\' : '/';
    return `→ ${createIn.replace(/[\\/]+$/, '')}${sep}${name}`;
  });

  onMount(() => {
    // An answer after this tab is gone (another machine chosen) is dropped:
    // a bound prop would still write it into the dialog.
    let live = true;
    api
      .githubStatus()
      .then((status) => {
        if (live) gh = status;
      })
      .catch((e: unknown) => {
        if (live) gh = { ready: false, login: null, problem: errorText(e) };
      });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    if (gh && !gh.ready) github = false;
  });
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

  <CreateInField bind:value={createIn} {api} {onThisPc} {machineName} {home} />

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
