<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import { wattsText } from '#lib/power-setup.js';
  import { useApp } from '#lib/state/context.js';
  import type { MachineEntry } from '#lib/state/machines.svelte.js';

  /**
   * The phone's power part of a machine's card in Settings → Machines: its
   * plug details (kept by the phone's core) and what the plug draws now, or
   * the hint to enter them. The desktop's card hands the plug to the machine
   * (`power.adopt`); this one never does.
   */
  let { machine }: { machine: MachineEntry } = $props();

  const { power, interaction } = useApp();

  const config = $derived(power.config(machine.id));
  const reading = $derived(power.reading(machine.id));
</script>

<div class="grid gap-2 border-t pt-2" role="group" aria-label="Plug">
  <h4 class="text-muted-foreground text-xs font-medium">Plug</h4>
  {#if config}
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-muted-foreground">Address</dt>
      <dd class="break-all">{config.address}</dd>
      {#if config.device}
        <dt class="text-muted-foreground">Plug</dt>
        <dd class="break-all">{config.device}</dd>
      {/if}
      <dt class="text-muted-foreground">Now drawing</dt>
      <dd>{reading ? wattsText(reading.watts) : 'unknown'}</dd>
    </dl>
  {:else}
    <p class="text-muted-foreground text-xs">
      Enter this machine's plug details to turn it on from here
    </p>
  {/if}
  {#if power.error(machine.id)}
    <p class="text-destructive text-xs" role="alert">{power.error(machine.id)}</p>
  {/if}
  <div>
    <Button variant="outline" size="sm" onclick={() => (interaction.plugFor = machine.id)}
      >Plug details…</Button
    >
  </div>
</div>
