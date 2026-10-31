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
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
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
   */
  let {
    machine,
    collapsed,
    onToggle,
  }: { machine: MachineEntry; collapsed: boolean; onToggle: () => void } = $props();

  const { interaction } = useApp();

  const name = $derived(machineLabel(machine));
  const shown = $derived(machineState(machine));
  const reasonId = $derived(`machine-reason-${machine.id}`);
</script>

<div class="flex min-w-0 items-center gap-1 pt-4 pr-1 pb-1">
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
        title={shown.reason}>{shown.label}</span
      >
      {#if shown.reason}
        <span class="sr-only">({shown.reason})</span>
      {/if}
    </span>
  </h3>
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
              onclick={() => (interaction.settingsOpen = true)}>Open settings</button
            >
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right" class="max-w-60 px-2 py-1">{shown.reason}</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
    <span id={reasonId} hidden>{shown.reason}</span>
  {/if}
</div>
