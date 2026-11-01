<script lang="ts">
  import { MachineAddressSchema, MachinePortSchema } from '@threadgarden/protocol';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import AddMachineDialog from '#lib/components/AddMachineDialog.svelte';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { machineState } from '#lib/components/layout/MachineHeading.svelte';
  import PowerSettings from '#lib/components/PowerSettings.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { useApp } from '#lib/state/context.js';
  import type { MachineEntry } from '#lib/state/machines.svelte.js';
  import { THIS_PC } from '#lib/state/refs.js';
  import { cn } from '#lib/utils.js';

  /**
   * Settings → Machines: This PC and every paired machine. Edits here are
   * immediate (they are not part of the dialog's Save): a machine's name, its
   * address and port (the pin stays, so a different machine at the new address
   * is still refused), and Remove, which also asks the machine to forget this
   * PC when it can be reached.
   */
  const { machines, interaction } = useApp();

  const paired = $derived(machines.list.filter((m) => !m.local));

  type Draft = { name: string; address: string; port: string };
  /** What the owner typed per machine id; absent: the machine's own values. */
  let drafts = $state<Record<string, Partial<Draft>>>({});
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string | null>>({});

  const valuesOf = (m: MachineEntry): Draft => ({
    name: m.name,
    address: m.address,
    port: String(m.port),
  });
  const draftOf = (m: MachineEntry): Draft => ({ ...valuesOf(m), ...drafts[m.id] });
  const edit = (m: MachineEntry, patch: Partial<Draft>): void => {
    drafts[m.id] = { ...drafts[m.id], ...patch };
  };

  /** The values each machine had when last seen, to tell a change from `machines.changed` from typing. */
  const seen = new Map<string, Draft>();
  $effect(() => {
    const focused = document.activeElement?.id ?? '';
    for (const m of paired) {
      const now = valuesOf(m);
      const before = seen.get(m.id);
      seen.set(m.id, now);
      const draft = drafts[m.id];
      if (!draft) continue;
      for (const key of Object.keys(draft) as (keyof Draft)[]) {
        const external = before !== undefined && before[key] !== now[key];
        // A field being edited keeps what is typed; the others follow the service.
        if ((external && focused !== `machine-${key}-${m.id}`) || draft[key] === now[key]) {
          delete draft[key];
        }
      }
      if (Object.keys(draft).length === 0) delete drafts[m.id];
    }
  });
  const dirty = (m: MachineEntry): boolean => {
    const d = draftOf(m);
    return d.name !== m.name || d.address !== m.address || d.port !== String(m.port);
  };

  const save = async (m: MachineEntry): Promise<void> => {
    const d = draftOf(m);
    const name = d.name.trim();
    if (!name || name.length > 40) {
      errors[m.id] = 'The name is 1 to 40 characters.';
      return;
    }
    const address = MachineAddressSchema.safeParse(d.address);
    if (!address.success) {
      errors[m.id] = 'The address is an IP address or a host name, such as ubuntu-pc.local.';
      return;
    }
    const port = MachinePortSchema.safeParse(Number(d.port.trim()));
    if (!port.success) {
      errors[m.id] = 'The port is a number from 1 to 65535.';
      return;
    }
    busy[m.id] = true;
    errors[m.id] = null;
    try {
      if (name !== m.name) await machines.rename(m.id, name);
      if (address.data !== m.address || port.data !== m.port) {
        await machines.setAddress(m.id, address.data, port.data);
      }
      delete drafts[m.id];
    } catch (err) {
      errors[m.id] = err instanceof Error ? err.message : String(err);
    } finally {
      busy[m.id] = false;
    }
  };

  let removing = $state<MachineEntry | null>(null);
  let removeOpen = $state(false);
  /**
   * A machine removed here that did not confirm it forgot this PC (unreachable,
   * locked, or it had already revoked it: the cause is not known).
   */
  let unconfirmed = $state<string | null>(null);

  const remove = async (m: MachineEntry): Promise<void> => {
    const revoked = await machines.remove(m.id);
    delete drafts[m.id];
    unconfirmed = revoked ? null : m.name;
  };

  const fieldClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<section class="grid gap-3 border-t pt-3" aria-labelledby="settings-machines">
  <h3
    id="settings-machines"
    class="text-muted-foreground text-xs font-medium outline-none"
    tabindex="-1"
  >
    Machines
  </h3>

  <p class="text-sm">{THIS_PC}</p>

  {#each paired as m (m.id)}
    {@const shown = machineState({ name: m.name, status: machines.shown(m) })}
    {@const d = draftOf(m)}
    <div class="grid gap-2 rounded-md border p-2" role="group" aria-label={m.name}>
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class={cn('font-medium', shown.tone === 'red' && 'text-red-700 dark:text-red-400')}
          >{shown.label}</span
        >
        {#if shown.reason}<span class="text-muted-foreground">{shown.reason}</span>{/if}
      </div>
      <div class="grid gap-1">
        <label for="machine-name-{m.id}" class="text-muted-foreground text-xs">Name</label>
        <input
          id="machine-name-{m.id}"
          class={fieldClass}
          maxlength={40}
          autocomplete="off"
          value={d.name}
          oninput={(e) => edit(m, { name: e.currentTarget.value })}
        />
      </div>
      <div class="grid grid-cols-[1fr_6rem] gap-2">
        <div class="grid gap-1">
          <label for="machine-address-{m.id}" class="text-muted-foreground text-xs">Address</label>
          <input
            id="machine-address-{m.id}"
            class={fieldClass}
            spellcheck="false"
            autocomplete="off"
            value={d.address}
            oninput={(e) => edit(m, { address: e.currentTarget.value })}
          />
        </div>
        <div class="grid gap-1">
          <label for="machine-port-{m.id}" class="text-muted-foreground text-xs">Port</label>
          <input
            id="machine-port-{m.id}"
            class={fieldClass}
            inputmode="numeric"
            value={d.port}
            oninput={(e) => edit(m, { port: e.currentTarget.value })}
          />
        </div>
      </div>
      <div aria-live="polite">
        {#if errors[m.id]}
          <p class="text-destructive text-xs" role="alert">{errors[m.id]}</p>
        {/if}
      </div>
      <!-- The group names the machine; the buttons say so to assistive technology only, so a long name never widens Settings. -->
      <div class="flex flex-wrap justify-end gap-1.5">
        <Button
          variant="outline"
          size="sm"
          aria-label="Save {m.name}"
          disabled={!dirty(m) || busy[m.id]}
          onclick={() => void save(m)}>Save</Button
        >
        <Button
          variant="ghost"
          size="sm"
          class="text-destructive"
          aria-label="Remove {m.name}"
          onclick={() => {
            removing = m;
            removeOpen = true;
          }}>Remove</Button
        >
      </div>
      <PowerSettings machine={m} />
    </div>
  {/each}

  {#if unconfirmed}
    <p class="text-muted-foreground text-xs" role="status">
      {unconfirmed} was removed here. It may still list this PC: on {unconfirmed}, run
      <code class="font-mono">threadgarden devices</code> and
      <code class="font-mono">threadgarden revoke &lt;id&gt;</code>.
    </p>
  {/if}

  <div>
    <Button variant="outline" size="sm" onclick={() => (interaction.addMachineOpen = true)}>
      <PlusIcon aria-hidden="true" /> Add machine…
    </Button>
  </div>
</section>

<AddMachineDialog />

<ConfirmDialog
  bind:open={removeOpen}
  title={`Remove ${removing?.name ?? ''}?`}
  description={`This PC forgets it, and ${removing?.name ?? ''} forgets this PC if it can be reached.`}
  confirmLabel="Remove"
  destructive
  onConfirm={() => (removing ? remove(removing) : undefined)}
  focusAfterConfirm={() => document.getElementById('settings-machines')}
/>
