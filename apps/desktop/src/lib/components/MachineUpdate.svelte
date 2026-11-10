<script lang="ts">
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { openExternal } from '#lib/native.js';
  import { useApp } from '#lib/state/context.js';
  import type { MachineEntry } from '#lib/state/machines.svelte.js';

  /**
   * The update part of a paired machine's card in Settings → Machines: the
   * button (or why there is none), how far a running update is, how the last
   * one ended and the question when chats would stop. The version line itself
   * is the card's.
   */
  let { machine }: { machine: MachineEntry } = $props();

  const { machineUpdates, machines, updates } = useApp();

  const windows = $derived(machine.info?.platform === 'win32');
  const guide = $derived(
    windows
      ? 'https://github.com/JiriPlasek/ThreadGarden/blob/main/docs/windows-machines.md#updating'
      : 'https://github.com/JiriPlasek/ThreadGarden/blob/main/docs/remote-machines.md#upgrading',
  );
  const SCRIPT = '~/.local/share/threadgarden-headless/current/install.sh';

  const latest = $derived(machineUpdates.latest);
  const stage = $derived(machineUpdates.stage(machine.id));
  const outcome = $derived(machineUpdates.outcome(machine.id));
  const behind = $derived(machineUpdates.behind(machine));
  const canStart = $derived(machineUpdates.canStart(machine));
  // Only a machine that can't answer is helped by turning it on; locked, mismatched and the like are not.
  const needsTurningOn = $derived(machines.shown(machine) === 'unreachable');

  const stageText = $derived(
    stage === 'turningOn'
      ? 'Turning on…'
      : stage === 'downloading'
        ? `Downloading ${machineUpdates.target(machine.id)}…`
        : stage === 'installing'
          ? 'Installing…'
          : stage === 'restarting'
            ? 'Restarting…'
            : null,
  );

  const failureText = $derived.by((): string | null => {
    if (outcome?.state !== 'failed') return null;
    const { version, from, reason, detail } = outcome;
    // A start failure with a detail is the desktop's own finding (the machine hasn't come back):
    // "back on <from>" would not be true of it.
    if (reason === 'start' && detail) return detail;
    switch (reason) {
      case 'download':
        return `Couldn't download ${version} from GitHub`;
      case 'checksum':
        return "The download's checksum didn't match";
      case 'unpack':
        return 'The download was damaged';
      case 'install':
        return `Installing ${version} failed; ${machine.name} is back on ${from}`;
      case 'start':
        return `${version} didn't start; ${machine.name} is back on ${from}`;
    }
  });

  const skipNotes = $derived(
    outcome?.state === 'done'
      ? outcome.skipped.map((step) =>
          step === 'polkit'
            ? `Updated. Idle shutdown can't power ${machine.name} off until you run ${SCRIPT} once over SSH.`
            : `Updated. Threadgarden won't start at boot on ${machine.name} until you run ${SCRIPT} once over SSH.`,
        )
      : [],
  );

  let askOpen = $state(false);
  let chats = $state(0);

  const press = async (): Promise<void> => {
    const answer = await machineUpdates.prepare(machine.id);
    if (!answer) return;
    chats = answer.busy;
    askOpen = true;
  };
</script>

<div class="grid min-w-0 gap-1 text-xs">
  {#if stageText}
    <p class="break-words" role="status">{stageText}</p>
  {:else}
    {#if outcome?.state === 'done'}
      <p class="break-words" role="status">Threadgarden {outcome.version} ✓</p>
      {#each skipNotes as note (note)}
        <p class="text-muted-foreground break-words">{note}</p>
      {/each}
    {:else if failureText}
      <p class="text-destructive break-words" role="alert">{failureText}</p>
    {/if}
    {#if behind && latest}
      <!-- The group names the machine; the label says so to assistive technology only. -->
      <div class="flex flex-wrap items-center justify-end gap-1.5">
        {#if !canStart && needsTurningOn}
          <span class="text-muted-foreground">Turn it on to update</span>
        {/if}
        <Button
          variant="outline"
          size="sm"
          aria-label="Update to {latest} on {machine.name}"
          disabled={!canStart}
          onclick={() => void press()}>Update to {latest}</Button
        >
      </div>
    {:else if machineUpdates.tooOld(machine)}
      <a
        href={guide}
        class="underline underline-offset-2"
        onclick={(e) => {
          e.preventDefault();
          openExternal(guide).catch(() => {});
        }}>Update it {windows ? 'on the Windows PC' : 'over SSH'} this once</a
      >
    {/if}
  {/if}
</div>

<ConfirmDialog
  bind:open={askOpen}
  title={`Update ${machine.name} now?`}
  description={`Claude is working in ${chats} ${chats === 1 ? 'chat' : 'chats'} on ${machine.name}. Updating restarts Threadgarden there and stops them.`}
  confirmLabel="Update anyway"
  onConfirm={() => machineUpdates.update(machine.id)}
>
  {#if updates.available}
    <p class="text-sm break-words">
      This PC has an update too; install it as well so they keep talking.
    </p>
  {/if}
</ConfirmDialog>
