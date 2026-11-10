<script lang="ts">
  import type { PowerConfig, PowerKind } from '@threadgarden/protocol';
  import { untrack } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { useApp } from '#lib/state/context.js';
  import { machineNameOf } from '#lib/state/machines.svelte.js';

  /**
   * The phone's plug details for a machine (`interaction.plugFor`): the switch
   * (a Zigbee plug through a Tasmota bridge, or a Tasmota Wi-Fi plug), its
   * address, the Zigbee plug's exact name and the web password, with the off
   * watts and the minimum off time under Advanced. The phone's core keeps them
   * (the password encrypted) and checks the password and the name on save;
   * what it refuses is shown as it says it. The password is never shown again:
   * left empty, the stored one stays.
   */
  const { interaction, machines, power } = useApp();

  const id = $derived(interaction.plugFor);
  const name = $derived(id ? machineNameOf(machines, id) : '');
  const stored = $derived(id ? power.config(id) : null);

  let kind = $state<PowerKind>('tasmota-zigbee');
  let address = $state('');
  let device = $state('');
  let password = $state('');
  let offWatts = $state('5');
  let minOff = $state('90');
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Each time it opens: the stored details, never the password.
  let wasFor: string | null = null;
  $effect(() => {
    const now = id;
    if (now && now !== wasFor) {
      untrack(() => {
        const c = stored;
        kind = c?.kind ?? 'tasmota-zigbee';
        address = c?.address ?? '';
        device = c?.device ?? '';
        offWatts = String(c?.offWatts ?? 5);
        minOff = String(c?.minOffSeconds ?? 90);
        password = '';
        error = null;
      });
    }
    wasFor = now;
  });

  const zigbee = $derived(kind === 'tasmota-zigbee');

  /** However it closes (Cancel, a swipe, after a failed save): no password stays behind. */
  const close = (): void => {
    password = '';
    interaction.plugFor = null;
  };

  const check = (): string | null => {
    if (!address.trim())
      return zigbee ? 'Enter the bridge’s address.' : 'Enter the plug’s address.';
    if (zigbee && !device.trim()) return 'Enter the plug’s name, exactly as the bridge has it.';
    if (!stored && !password) return 'Enter the switch’s web password.';
    const w = Number(offWatts);
    if (!Number.isFinite(w) || w < 0.5 || w > 100) return 'Off below is 0.5 to 100 W.';
    const s = Number(minOff);
    if (!Number.isInteger(s) || s < 10 || s > 600) return 'The wait is 10 to 600 seconds.';
    return null;
  };

  const save = async (): Promise<void> => {
    const machineId = id;
    if (!machineId) return;
    const problem = check();
    if (problem) {
      error = problem;
      return;
    }
    const config: PowerConfig = {
      kind,
      address: address.trim(),
      device: zigbee ? device.trim() : null,
      offWatts: Number(offWatts),
      minOffSeconds: Number(minOff),
      measured: stored?.measured ?? { running: null, standby: null },
    };
    busy = true;
    error = null;
    try {
      await power.configure(machineId, config, password ? password : undefined);
      password = '';
      close();
    } catch (err) {
      // As the core says it: a wrong password, a name the bridge doesn't have.
      error = err instanceof Error && err.message ? err.message : 'The details were not saved.';
    } finally {
      busy = false;
    }
  };

  const forget = async (): Promise<void> => {
    const machineId = id;
    if (!machineId) return;
    busy = true;
    error = null;
    try {
      await power.configure(machineId, null);
      close();
    } catch (err) {
      error = err instanceof Error && err.message ? err.message : 'The details were not removed.';
    } finally {
      busy = false;
    }
  };

  const field = 'bg-background h-11 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<Dialog.Root
  open={id !== null}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="max-h-[90vh] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto p-4">
    <Dialog.Header>
      <Dialog.Title class="text-base">Plug for {name}</Dialog.Title>
      <Dialog.Description class="text-xs">
        The Tasmota switch {name} is plugged into. Turn on uses it from this phone, on your home network.
      </Dialog.Description>
    </Dialog.Header>

    <form
      class="grid gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="grid gap-1">
        <label for="plug-kind" class="text-muted-foreground text-xs">Switch</label>
        <select id="plug-kind" class={field} bind:value={kind}>
          <option value="tasmota-zigbee">Zigbee plug, through a Tasmota bridge</option>
          <option value="tasmota-plug">Tasmota Wi-Fi plug</option>
        </select>
      </div>
      <div class="grid gap-1">
        <label for="plug-address" class="text-muted-foreground text-xs"
          >{zigbee ? 'Bridge address' : 'Plug address'}</label
        >
        <input
          id="plug-address"
          class={field}
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="192.168.1.20"
          bind:value={address}
        />
      </div>
      {#if zigbee}
        <div class="grid gap-1">
          <label for="plug-device" class="text-muted-foreground text-xs">Plug name</label>
          <input
            id="plug-device"
            class={field}
            autocomplete="off"
            spellcheck="false"
            aria-describedby="plug-device-hint"
            bind:value={device}
          />
          <p id="plug-device-hint" class="text-muted-foreground text-xs">
            Exactly as the bridge names it (Zigbee friendly name).
          </p>
        </div>
      {/if}
      <div class="grid gap-1">
        <label for="plug-password" class="text-muted-foreground text-xs">Password</label>
        <input
          id="plug-password"
          type="password"
          class={field}
          autocomplete="off"
          placeholder={stored
            ? 'Stored — enter a new one to change it'
            : 'The switch’s web password'}
          bind:value={password}
        />
      </div>

      <details class="text-sm">
        <summary class="text-muted-foreground min-h-11 cursor-pointer py-2 text-xs"
          >Advanced</summary
        >
        <div class="grid grid-cols-2 gap-3 pt-1">
          <div class="grid gap-1">
            <label for="plug-off-watts" class="text-muted-foreground text-xs">Off below (W)</label>
            <input id="plug-off-watts" class={field} inputmode="decimal" bind:value={offWatts} />
          </div>
          <div class="grid gap-1">
            <label for="plug-min-off" class="text-muted-foreground text-xs"
              >Wait before switching on (s)</label
            >
            <input id="plug-min-off" class={field} inputmode="numeric" bind:value={minOff} />
          </div>
        </div>
      </details>

      <div aria-live="polite">
        {#if error}<p class="text-destructive text-xs" role="alert">{error}</p>{/if}
      </div>

      <div class="flex flex-wrap justify-between gap-2">
        {#if stored}
          <Button
            type="button"
            variant="ghost"
            class="text-destructive"
            disabled={busy}
            onclick={() => void forget()}>Remove details</Button
          >
        {:else}
          <span></span>
        {/if}
        <div class="flex gap-2">
          <Button type="button" variant="outline" onclick={close}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Save'}</Button>
        </div>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
