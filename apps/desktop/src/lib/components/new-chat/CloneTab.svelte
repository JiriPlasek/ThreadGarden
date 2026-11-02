<script lang="ts">
  import type { GithubStatus, Repo } from '@threadgarden/protocol';
  import { onMount } from 'svelte';
  import { fullTime, relativeTime } from '#lib/format/time.js';
  import { projectsApi, type ProjectsApi } from '#lib/projects.js';
  import CreateInField from './CreateInField.svelte';
  import { watchClone, type CloneWatch } from './clone.js';
  import { asNow, errorText, type MadeFolder, type Send } from './start.js';

  /**
   * New chat's Clone tab: every repo the machine's `gh` account reaches
   * (newest first, searchable, marked when This PC already has it), and the
   * shared Create in. The dialog calls `submit` on send; the tab clones, shows
   * the progress with Cancel and returns the clone for the chat to start in.
   * While a clone runs the dialog keeps its machine and tab (`busy`); one
   * still running when the tab goes away (the dialog closed) is cancelled.
   */
  let {
    createIn = $bindable(),
    busy = $bindable(false),
    api,
    thisPc,
    onThisPc,
    machineName,
    home,
    startIn,
  }: {
    createIn: string;
    /** A clone is running (the dialog keeps its machine and tab meanwhile). */
    busy?: boolean;
    /** The chosen machine's projects methods. */
    api: ProjectsApi;
    /** This PC's, for which repos it already has (`origins`). */
    thisPc: Pick<ProjectsApi, 'origins'>;
    onThisPc: boolean;
    machineName: string;
    home: string | null;
    /** Starts the chat in an existing folder (Start there); true once it started. */
    startIn: (send: Send, path: string) => Promise<boolean>;
  } = $props();

  let gh = $state<GithubStatus | null>(null);
  let repos = $state.raw<Repo[] | null>(null);
  let listError = $state<string | null>(null);
  /** Lower-case `owner/name` of This PC's projects' origins. */
  let here = $state.raw(new Set<string>());
  let query = $state('');
  let repo = $state('');
  /** The repo being cloned, while its job runs. */
  let cloning = $state<string | null>(null);
  /** The repo is already on the machine: where, and the send that found it. */
  let existing = $state<{ path: string; send: Send } | null>(null);

  let live = true;
  let run: CloneWatch | null = null;

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
  });

  // A choice the search hides is no choice: Send must not clone a repo out of sight.
  $effect(() => {
    if (repo && !shown.some((r) => r.fullName === repo)) repo = '';
  });

  $effect(() => {
    busy = cloning !== null;
  });

  const loadRepos = (): void => {
    api
      .repos()
      .then((list) => {
        if (live) repos = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      })
      .catch((e: unknown) => {
        if (live) listError = errorText(e);
      });
    thisPc
      .origins()
      .then((list) => {
        if (live) here = new Set(list);
      })
      .catch(() => {});
  };

  onMount(() => {
    api
      .githubStatus()
      .then((status) => {
        if (!live) return;
        gh = status;
        if (status.ready) loadRepos();
      })
      .catch((e: unknown) => {
        if (live) gh = { ready: false, login: null, problem: errorText(e) };
      });
    return () => {
      live = false;
      run?.cancel();
    };
  });

  /**
   * Clones the chosen repo on the send's machine and follows the job. Resolves
   * the clone once done; null when there is nothing to start (already there,
   * cancelled, or the tab gone). Throws what the service or git said.
   */
  export const submit = async (send: Send): Promise<MadeFolder | null> => {
    existing = null;
    if (!repo) throw new Error('Choose a repo to clone first.');
    if (!createIn) throw new Error('Choose where to clone it first.');
    const on = projectsApi(send.target.api);
    const chosen = repo;
    const result = await on.clone({ createIn, repo: chosen });
    if (result.status === 'existing') {
      if (live) existing = { path: result.path, send };
      return null;
    }
    const watch = watchClone(on, result.job);
    if (!live) {
      watch.cancel();
      return null;
    }
    run = watch;
    cloning = chosen;
    try {
      const job = await watch.settled;
      if (!job || job.state === 'cancelled' || !live) return null;
      if (job.state === 'failed') throw new Error(job.error ?? `Cloning ${chosen} failed.`);
      return { name: chosen, path: job.path, problem: null };
    } finally {
      if (run === watch) {
        run = null;
        cloning = null;
      }
    }
  };

  /** Starts the chat in the clone already there, with the message as it is now. */
  const startThere = async (): Promise<void> => {
    const at = existing;
    if (!at) return;
    if (await startIn(asNow(at.send), at.path)) {
      at.send.target.interaction.clearDraft(at.send.draftKey);
    }
  };

  const inputClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<div class="grid gap-2 text-xs">
  {#if !gh}
    <p class="text-muted-foreground">Checking GitHub on {machineName}…</p>
  {:else if !gh.ready}
    <p role="note" class="rounded-md bg-amber-500/15 px-2 py-1.5">
      {gh.problem ?? `The GitHub CLI isn't ready on ${machineName}.`}
    </p>
  {:else}
    <input
      type="search"
      class={inputClass}
      aria-label="Search repos"
      placeholder="Search owner/name"
      spellcheck="false"
      autocomplete="off"
      bind:value={query}
    />
    {#if listError}
      <p class="text-destructive">{listError}</p>
    {:else if !repos}
      <p class="text-muted-foreground">Loading repos…</p>
    {:else}
      <div
        role="radiogroup"
        aria-label="Repos"
        class="max-h-48 overflow-y-auto rounded-md border py-1"
      >
        {#each shown as r (r.fullName)}
          <label class="hover:bg-muted flex min-w-0 items-center gap-2 px-2 py-1">
            <input type="radio" name="clone-repo" value={r.fullName} bind:group={repo} />
            <span class="truncate font-mono">{r.fullName}</span>
            <span class="text-muted-foreground shrink-0">{r.private ? 'private' : 'public'}</span>
            {#if here.has(r.fullName.toLowerCase())}
              <span class="bg-muted shrink-0 rounded px-1">on This PC</span>
            {/if}
            <span class="text-muted-foreground ml-auto shrink-0" title={fullTime(r.updatedAt)}
              >{relativeTime(r.updatedAt)}</span
            >
          </label>
        {:else}
          <p class="text-muted-foreground px-2 py-1">
            {repos.length ? 'No repo matches.' : 'No repos on this account.'}
          </p>
        {/each}
      </div>
    {/if}
  {/if}

  <CreateInField bind:value={createIn} {api} {onThisPc} {machineName} {home} />

  {#if cloning}
    <p role="status" class="flex items-center gap-2">
      <span>Cloning {cloning}…</span>
      <button type="button" class="underline underline-offset-2" onclick={() => run?.cancel()}
        >Cancel</button
      >
    </p>
  {:else if existing}
    <p role="status">
      Already cloned in {existing.path}
      <button type="button" class="underline underline-offset-2" onclick={() => void startThere()}
        >Start there</button
      >
    </p>
  {/if}
</div>
