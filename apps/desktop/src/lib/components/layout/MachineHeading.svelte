<script lang="ts" module>
  import type { MachineEntry, MachineStatus } from '#lib/state/machines.svelte.js';

  type Tone = 'green' | 'amber' | 'red';
  type Shown = { label: string; tone: Tone; reason?: string };

  const attention = (reason: string): Shown => ({ label: 'Needs attention', tone: 'red', reason });

  /** What a machine's heading says about it: a label, its dot's colour and, when it needs attention, why. */
  export const machineState = (m: Pick<MachineEntry, 'status' | 'name'>): Shown => {
    const s: MachineStatus = m.status;
    switch (s) {
      case 'on':
        return { label: 'On', tone: 'green' };
      case 'connecting':
        return { label: 'Connecting…', tone: 'amber' };
      case 'unreachable':
        return { label: 'Unreachable', tone: 'amber' };
      case 'off':
        return { label: 'Off', tone: 'red' };
      case 'starting':
        return { label: 'Starting…', tone: 'amber' };
      case 'shuttingDown':
        return { label: 'Shutting down', tone: 'amber' };
      case 'mismatch':
        return attention('This address answers as a different machine');
      case 'refused':
        return attention(`This device was removed on ${m.name}`);
      case 'locked':
        return attention('Pair again');
      case 'incompatible':
        return attention('Different Threadgarden version');
      default: {
        const unknown: never = s;
        throw new Error(`Unknown machine status: ${String(unknown)}`);
      }
    }
  };
</script>

<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import PowerIcon from '@lucide/svelte/icons/power';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { clockTime, spanText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel } from '#lib/state/machines.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * A machine's group heading in the places column (remote machines, layout
   * A): its name (This PC for the local one) as the group's collapse toggle,
   * then its state as a dot and a label, never colour alone. A machine that
   * needs attention says why (on hover of the label, to assistive technology
   * in the heading) and offers "Open settings", where machines are managed;
   * that button carries the reason too, as its description and its tooltip.
   *
   * A machine with power control also gets a ⏻ menu (Turn on, Shut down now,
   * Keep awake), its idle-shutdown countdown or keep-awake time in the state
   * label's title, and, when turning it on failed, the reason in a line under
   * the heading.
   */
  let {
    machine,
    collapsed,
    onToggle,
  }: { machine: MachineEntry; collapsed: boolean; onToggle: () => void } = $props();

  const { interaction, machines, power } = useApp();

  const name = $derived(machineLabel(machine));
  const status = $derived(machines.shown(machine));
  const shown = $derived(machineState({ name: machine.name, status }));
  const hasPower = $derived(!machine.local && power.config(machine.id) !== null);
  const awake = $derived(power.machine(machine.id)?.keepAwake);
  const starting = $derived(power.turningOn(machine.id));
  const failure = $derived(power.error(machine.id));

  /** What the menu offers: Turn on whenever the plug reads off, else only what the state allows. */
  const plugOff = $derived.by((): boolean => {
    const r = power.reading(machine.id);
    const line = power.config(machine.id)?.offWatts ?? 0;
    return r !== null && (r.on === false || (r.watts !== null && r.watts < line));
  });
  const canTurnOn = $derived(
    status === 'off' ||
      status === 'unreachable' ||
      (status !== 'on' && status !== 'shuttingDown' && status !== 'starting' && plugOff),
  );

  /** A clock that ticks (twice a minute) only while an idle-shutdown countdown is shown. */
  let now = $state(Date.now());
  const counting = $derived(
    status === 'on' &&
      power.machine(machine.id)?.keepAwake.mode === 'off' &&
      power.machine(machine.id)?.shutsDownAt != null,
  );
  $effect(() => {
    if (!counting) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** The countdown to an idle shutdown, or how long the machine is kept awake. */
  const powerTitle = $derived.by((): string | undefined => {
    if (status !== 'on') return undefined;
    const st = power.machine(machine.id);
    if (!st) return undefined;
    if (st.keepAwake.mode === 'always') return 'Kept awake';
    if (st.keepAwake.mode === 'until' && st.keepAwake.until !== null)
      return `Kept awake until ${clockTime(st.keepAwake.until)}`;
    if (st.shutsDownAt !== null)
      return `Shuts down in ${spanText(Math.max(0, st.shutsDownAt - now))}`;
    return undefined;
  });

  const HOUR = 3_600_000;
  const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
  const keepAwake = (mode: 'until' | 'always' | 'off', ms?: number): void =>
    quiet(
      power.keepAwake(machine.id, {
        mode,
        until: mode === 'until' && ms !== undefined ? Date.now() + ms : null,
      }),
    );
  const reasonId = $derived(`machine-reason-${machine.id}`);
</script>

<div class="pt-4 pr-1 pb-1">
  <div class="flex min-w-0 items-center gap-1">
    <h3
      class="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-[0.6875rem] font-medium"
    >
      <button
        type="button"
        class="hover:text-foreground focus-visible:ring-ring/50 flex min-w-0 items-center gap-1 rounded-sm px-0.5 tracking-wide uppercase outline-none focus-visible:ring-2"
        aria-expanded={!collapsed}
        onclick={onToggle}
      >
        <ChevronRightIcon
          class={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')}
          aria-hidden="true"
        />
        <span class="truncate">{name}</span>
      </button>
      <span class="flex shrink-0 items-center gap-1 font-normal">
        <span
          aria-hidden="true"
          class={cn(
            'size-1.5 rounded-full',
            shown.tone === 'green' && 'bg-emerald-500',
            shown.tone === 'amber' && 'bg-amber-500',
            shown.tone === 'red' && 'bg-red-500',
          )}
        ></span>
        <span
          class={cn(shown.tone === 'red' && 'text-red-700 dark:text-red-400')}
          title={shown.reason ?? powerTitle}>{shown.label}</span
        >
        {#if shown.reason}
          <span class="sr-only">({shown.reason})</span>
        {/if}
      </span>
    </h3>
    {#if hasPower}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Power for {name}"
            >
              <PowerIcon />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="min-w-40">
          {#if starting}
            <DropdownMenu.Item class="py-1 text-xs" disabled>Starting…</DropdownMenu.Item>
          {:else if status === 'shuttingDown'}
            <DropdownMenu.Item class="py-1 text-xs" disabled>Shutting down…</DropdownMenu.Item>
          {:else if canTurnOn}
            <DropdownMenu.Item
              class="py-1 text-xs"
              onSelect={() => quiet(power.turnOn(machine.id))}
            >
              Turn on
            </DropdownMenu.Item>
          {:else if status !== 'on'}
            <DropdownMenu.Item class="py-1 text-xs" disabled>{shown.label}</DropdownMenu.Item>
          {/if}
          {#if status === 'on'}
            <DropdownMenu.Item
              class="py-1 text-xs"
              onSelect={() => quiet(power.shutDown(machine.id, false))}
            >
              Shut down now
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger class="py-1 text-xs">Keep awake</DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="min-w-40">
                <DropdownMenu.Item class="py-1 text-xs" onSelect={() => keepAwake('until', HOUR)}>
                  For 1 hour
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="py-1 text-xs"
                  onSelect={() => keepAwake('until', 4 * HOUR)}
                >
                  For 4 hours
                </DropdownMenu.Item>
                <DropdownMenu.Item class="py-1 text-xs" onSelect={() => keepAwake('always')}>
                  Until I turn it off
                </DropdownMenu.Item>
                {#if awake && awake.mode !== 'off'}
                  <DropdownMenu.Item class="py-1 text-xs" onSelect={() => keepAwake('off')}>
                    Stop keeping awake
                  </DropdownMenu.Item>
                {/if}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
    {#if shown.reason}
      <Tooltip.Provider delayDuration={400}>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm px-1 text-[0.6875rem] underline underline-offset-2 outline-none focus-visible:ring-2"
                aria-describedby={reasonId}
                onclick={() => {
                  interaction.settingsSection = 'machines';
                  interaction.settingsOpen = true;
                }}>Open settings</button
              >
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="right" class="max-w-60 px-2 py-1">{shown.reason}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
      <span id={reasonId} hidden>{shown.reason}</span>
    {/if}
  </div>
  <!-- Always present, so assistive technology announces what is put in it. -->
  <p class="px-2 text-xs text-red-700 empty:hidden dark:text-red-400" role="status">
    {failure ?? ''}
  </p>
</div>
