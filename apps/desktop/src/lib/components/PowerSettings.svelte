<script lang="ts">
  import { untrack } from 'svelte';
  import { POWER_CAPABILITY } from '@threadgarden/protocol';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import PowerSetupDialog from '#lib/components/PowerSetupDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { suggestOffWatts, wattsText } from '#lib/power-setup.js';
  import { useApp } from '#lib/state/context.js';
  import type { MachineEntry } from '#lib/state/machines.svelte.js';

  /**
   * The Power subsection of a paired machine's card in Settings → Machines,
   * for a machine that offers power control: a button to set it up, or what is
   * set up (the switch, the plug, its live watts, the "off" line, the wait
   * before switching on), the suggested "off" line once both draws are known,
   * "Shut down after idle" (kept on the machine itself) and Remove.
   */
  let { machine }: { machine: MachineEntry } = $props();

  const { power } = useApp();

  const capable = $derived(!!machine.info?.capabilities.includes(POWER_CAPABILITY));
  const config = $derived(power.config(machine.id));
  const reading = $derived(power.reading(machine.id));
  const isOn = $derived(machine.status === 'on');

  const suggestion = $derived.by(() => {
    const m = config?.measured;
    if (!config || !m || m.running === null || m.standby === null) return null;
    const watts = suggestOffWatts(m.running, m.standby);
    return watts === config.offWatts ? null : watts;
  });

  let setupOpen = $state(false);
  let removeOpen = $state(false);
  let error = $state<string | null>(null);

  const use = async (watts: number): Promise<void> => {
    if (!config) return;
    error = null;
    try {
      await power.configure(machine.id, { ...config, offWatts: watts });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  };

  // ── shut down after idle: a setting of the machine itself ─────────────────

  const IDLE_CHOICES: { minutes: number | null; label: string }[] = [
    { minutes: null, label: 'Never' },
    { minutes: 30, label: '30 min' },
    { minutes: 60, label: '1 hour' },
    { minutes: 120, label: '2 hours' },
    { minutes: 240, label: '4 hours' },
  ];
  /** The machine's value; undefined until it has said. */
  let idle = $state<number | null | undefined>(undefined);
  let idleError = $state<string | null>(null);

  const idleChoices = $derived(
    typeof idle === 'number' && !IDLE_CHOICES.some((c) => c.minutes === idle)
      ? [...IDLE_CHOICES, { minutes: idle, label: `${idle} min` }]
      : IDLE_CHOICES,
  );
  const keyOf = (m: number | null): string => (m === null ? 'never' : String(m));

  $effect(() => {
    if (!capable || !config || !isOn) return;
    const client = machine.client;
    let current = true;
    untrack(() => {
      client
        .request('settings.get', {})
        .then((s) => {
          if (current) idle = s.idleShutdownMinutes;
        })
        .catch(() => {});
    });
    return () => {
      current = false;
    };
  });

  const setIdle = async (key: string): Promise<void> => {
    const minutes = key === 'never' ? null : Number(key);
    const before = idle;
    idle = minutes;
    idleError = null;
    try {
      const s = await machine.client.request('settings.set', { idleShutdownMinutes: minutes });
      idle = s.idleShutdownMinutes;
    } catch (e) {
      idle = before;
      idleError = e instanceof Error ? e.message : String(e);
    }
  };

  const fieldClass = 'bg-background h-8 rounded-md border px-2 text-sm';
</script>

{#if capable}
  <div class="grid gap-2 border-t pt-2" role="group" aria-label="Power control">
    <h4 class="text-muted-foreground text-xs font-medium">Power</h4>

    {#if !config}
      {#if isOn}
        <div>
          <Button
            id="power-setup-{machine.id}"
            variant="outline"
            size="sm"
            onclick={() => (setupOpen = true)}>Set up power control…</Button
          >
        </div>
      {:else}
        <p class="text-muted-foreground text-xs">
          Connect the machine once to set up power control
        </p>
      {/if}
    {:else}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt class="text-muted-foreground">Switch</dt>
        <dd>
          {config.kind === 'tasmota-zigbee' ? 'Tasmota Zigbee bridge' : 'Tasmota Wi-Fi plug'}
          {#if config.kind === 'tasmota-plug'}
            <span class="ml-1 rounded border px-1 py-0.5 font-medium">Experimental</span>
          {/if}
        </dd>
        <dt class="text-muted-foreground">Address</dt>
        <dd>{config.address}</dd>
        {#if config.device}
          <dt class="text-muted-foreground">Plug</dt>
          <dd>{config.device}</dd>
        {/if}
        <dt class="text-muted-foreground">Now drawing</dt>
        <dd>{reading ? wattsText(reading.watts) : 'unknown'}</dd>
        <dt class="text-muted-foreground">Off below</dt>
        <dd>{config.offWatts} W</dd>
        <dt class="text-muted-foreground">Wait before switching on</dt>
        <dd>{config.minOffSeconds} s</dd>
      </dl>

      {#if suggestion !== null}
        <p class="flex flex-wrap items-center gap-2 text-xs">
          <span
            >Measured: {wattsText(config.measured.running)} running, {wattsText(
              config.measured.standby,
            )} shut down — suggest off below {suggestion} W</span
          >
          <Button variant="outline" size="sm" onclick={() => void use(suggestion)}>Use</Button>
        </p>
      {/if}

      <div class="grid gap-1">
        <label for="power-idle-{machine.id}" class="text-muted-foreground text-xs"
          >Shut down after idle</label
        >
        <select
          id="power-idle-{machine.id}"
          class="{fieldClass} w-40"
          disabled={!isOn || idle === undefined}
          value={idle === undefined ? '' : keyOf(idle)}
          onchange={(e) => void setIdle(e.currentTarget.value)}
        >
          {#if idle === undefined}<option value="" hidden></option>{/if}
          {#each idleChoices as c (keyOf(c.minutes))}
            <option value={keyOf(c.minutes)}>{c.label}</option>
          {/each}
        </select>
        {#if !isOn}
          <p class="text-muted-foreground text-xs">Changed while {machine.name} is on.</p>
        {/if}
      </div>

      <div aria-live="polite">
        {#if error ?? idleError}
          <p class="text-destructive text-xs" role="alert">{error ?? idleError}</p>
        {/if}
      </div>

      <div class="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          class="text-destructive"
          onclick={() => (removeOpen = true)}>Remove power control</Button
        >
      </div>
    {/if}
  </div>

  <PowerSetupDialog {machine} bind:open={setupOpen} />

  <ConfirmDialog
    bind:open={removeOpen}
    title={`Remove power control for ${machine.name}?`}
    description="Threadgarden takes its rule off the switch and forgets the switch and its password. The switch itself keeps working."
    confirmLabel="Remove"
    destructive
    onConfirm={async () => {
      await power.configure(machine.id, null);
    }}
    focusAfterConfirm={() => document.getElementById(`power-setup-${machine.id}`)}
  />
{/if}
