<script lang="ts" module>
  import type { MachineEntry, MachineStatus } from '#lib/state/machines.svelte.js';

  type Tone = 'green' | 'amber' | 'red';

  /** What a machine's heading says about it: a label, its dot's colour and, when it needs attention, why. */
  export const machineState = (
    m: Pick<MachineEntry, 'status' | 'name'>,
  ): { label: string; tone: Tone; reason?: string } => {
    const attention = (reason: string) => ({
      label: 'Needs attention',
      tone: 'red' as const,
      reason,
    });
    const s: MachineStatus = m.status;
    if (s === 'on') return { label: 'On', tone: 'green' };
    if (s === 'connecting') return { label: 'Connecting…', tone: 'amber' };
    if (s === 'unreachable') return { label: 'Unreachable', tone: 'amber' };
    if (s === 'mismatch') return attention('This address answers as a different machine');
    if (s === 'refused') return attention(`This device was removed on ${m.name}`);
    if (s === 'locked') return attention('Pair again');
    return attention('Different Threadgarden version');
  };
</script>

<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel } from '#lib/state/machines.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * A machine's group heading in the places column (remote machines, layout
   * A): its name (This PC for the local one) as the group's collapse toggle,
   * then its state as a dot and a label, never colour alone. A machine that
   * needs attention says why on hover (and to assistive technology) and links
   * to Settings, where machines are managed.
   */
  let {
    machine,
    collapsed,
    onToggle,
  }: { machine: MachineEntry; collapsed: boolean; onToggle: () => void } = $props();

  const { interaction } = useApp();

  const name = $derived(machineLabel(machine));
  const shown = $derived(machineState(machine));
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
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm px-1 text-[0.6875rem] underline underline-offset-2 outline-none focus-visible:ring-2"
      title="Settings → Machines"
      onclick={() => (interaction.settingsOpen = true)}>Open settings</button
    >
  {/if}
</div>
