<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { POWER_ERRORS, type ProbeResult, type SwitchDevice } from '@threadgarden/protocol';
  import { RequestError } from '#lib/service/client.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { plugNameFor, powerFailure, wattsText, type PowerFailure } from '#lib/power-setup.js';
  import { useApp } from '#lib/state/context.js';
  import type { MachineEntry } from '#lib/state/machines.svelte.js';

  /**
   * Guided setup of a machine's power switch (Settings → Machines → Power →
   * Set up power control…): Connect (address and web password; the switch is
   * probed), Choose the plug (a Zigbee bridge only), Check (live watts, the
   * "off" line and the wait before switching on). Saving goes through
   * `power.configure`, which keeps the password in the keychain and hands the
   * configuration to the machine. Nothing here ever switches the plug off.
   *
   * The watts in Check are the plug's reading at the last probe; Refresh reads
   * again, and at most once every 5 seconds.
   */
  let { machine, open = $bindable(false) }: { machine: MachineEntry; open?: boolean } = $props();

  const { machines, power } = useApp();

  const PAIR_SECONDS = 60;
  const REFRESH_MS = 5_000;

  type Step = 'connect' | 'choose' | 'check';

  let step = $state<Step>('connect');
  let address = $state('');
  let password = $state('');
  let busy = $state(false);
  let failure = $state<PowerFailure | null>(null);
  /** The switch as the last probe found it. */
  let probed = $state<ProbeResult | null>(null);
  /** What the probe was asked with: Refresh and Save use these, not whatever was typed since. */
  let used = $state<{ address: string; password: string } | null>(null);
  let devices = $state<SwitchDevice[]>([]);
  let chosen = $state<string | null>(null);
  let pairNotice = $state<string | null>(null);
  let pairLeft = $state<number | null>(null);
  let offWatts = $state('5');
  let minOffSeconds = $state('90');
  let refreshLocked = $state(false);

  let heading = $state<HTMLElement | null>(null);
  let pairTimer: ReturnType<typeof setInterval> | undefined;
  let lockTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every reset, so an answer that arrives after the dialog closed is dropped. */
  let run = 0;

  const reset = (): void => {
    run++;
    clearInterval(pairTimer);
    clearTimeout(lockTimer);
    step = 'connect';
    address = power.config(machine.id)?.address ?? '';
    password = '';
    busy = false;
    failure = null;
    probed = null;
    used = null;
    devices = [];
    chosen = null;
    pairNotice = null;
    pairLeft = null;
    offWatts = '5';
    minOffSeconds = '90';
    refreshLocked = false;
  };

  $effect(() => {
    // Every way the dialog closes ends up here; the password never outlives it.
    if (!open) untrack(reset);
  });

  const goto = async (next: Step): Promise<void> => {
    step = next;
    failure = null;
    await tick();
    heading?.focus();
  };

  const metered = (list: SwitchDevice[]): SwitchDevice[] => list.filter((d) => d.metering);
  const label = (d: SwitchDevice): string => `${d.name ?? d.id} — ${wattsText(d.watts)}`;
  const device = $derived(devices.find((d) => d.id === chosen) ?? null);
  const isPlug = $derived(probed?.kind === 'tasmota-plug');

  const probe = async (): Promise<ProbeResult | null> => {
    const local = machines.local;
    if (!local || !used) return null;
    const my = run;
    try {
      const r = await local.client.request('power.probe', used);
      return my === run ? r : null;
    } catch (e) {
      if (my === run) failure = powerFailure(e, used.address);
      return null;
    }
  };

  const connect = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !address.trim() || !password) return;
    busy = true;
    failure = null;
    used = { address: address.trim(), password };
    const r = await probe();
    busy = false;
    if (!r) return;
    probed = r;
    devices = metered(r.devices);
    chosen = devices.length === 1 ? devices[0]!.id : null;
    await goto(r.kind === 'tasmota-plug' ? 'check' : 'choose');
  };

  const pair = async (): Promise<void> => {
    const local = machines.local;
    if (!local || !used || busy) return;
    const my = run;
    busy = true;
    failure = null;
    pairNotice = null;
    pairLeft = PAIR_SECONDS;
    pairTimer = setInterval(() => {
      if (pairLeft !== null && pairLeft > 0) pairLeft--;
    }, 1000);
    try {
      const found = await local.client.request('power.pairPlug', used);
      if (my !== run) return;
      if (!found) {
        pairNotice =
          'No new plug joined. Try again, and hold its button until the LED blinks fast.';
        return;
      }
      let named: SwitchDevice = found;
      try {
        const name = plugNameFor(machine.name);
        await local.client.request('power.rename', { ...used, id: found.id, name });
        named = { ...found, name };
      } catch {
        // It keeps its own id as its name: still usable.
      }
      if (my !== run) return;
      if (!named.metering) {
        failure = powerFailure(new RequestError(POWER_ERRORS.noMetering, ''), used.address);
        return;
      }
      devices = [...devices.filter((d) => d.id !== named.id), named];
      chosen = named.id;
    } catch (e) {
      if (my === run) failure = powerFailure(e, used.address);
    } finally {
      if (my === run) {
        clearInterval(pairTimer);
        pairLeft = null;
        busy = false;
      }
    }
  };

  const lockRefresh = (): void => {
    refreshLocked = true;
    lockTimer = setTimeout(() => (refreshLocked = false), REFRESH_MS);
  };

  const refresh = async (): Promise<void> => {
    if (busy || refreshLocked) return;
    busy = true;
    failure = null;
    lockRefresh();
    const r = await probe();
    busy = false;
    if (!r) return;
    probed = r;
    devices = metered(r.devices);
  };

  const num = (text: string): number => (text.trim() === '' ? NaN : Number(text));
  const offOk = $derived(num(offWatts) >= 0.5 && num(offWatts) <= 100);
  const waitOk = $derived(
    Number.isInteger(num(minOffSeconds)) && num(minOffSeconds) >= 10 && num(minOffSeconds) <= 600,
  );

  const live = $derived(isPlug ? (probed?.plug?.watts ?? null) : (device?.watts ?? null));

  const save = async (): Promise<void> => {
    if (busy || !probed || !used || !offOk || !waitOk) return;
    if (!isPlug && !device) return;
    busy = true;
    failure = null;
    const my = run;
    try {
      await power.configure(
        machine.id,
        {
          kind: probed.kind,
          address: used.address,
          device: isPlug ? null : (device!.name ?? device!.id),
          offWatts: num(offWatts),
          minOffSeconds: num(minOffSeconds),
          measured: { running: null, standby: null },
        },
        used.password,
      );
      open = false;
    } catch (e) {
      if (my === run) failure = powerFailure(e, used.address);
    } finally {
      if (my === run) busy = false;
    }
  };

  const fieldClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
  const headingClass = 'text-sm font-medium outline-none';
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="gap-4 p-5 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-base">Set up power control</Dialog.Title>
      <Dialog.Description class="text-xs"
        >Connect the Tasmota power switch {machine.name} is plugged into, so Threadgarden can turn it
        on and shut it down.</Dialog.Description
      >
    </Dialog.Header>

    {#if step === 'connect'}
      <form class="grid gap-3" onsubmit={(e) => void connect(e)}>
        <h4 bind:this={heading} tabindex="-1" class={headingClass}>Connect</h4>
        <div class="grid gap-1">
          <label for="power-address" class="text-muted-foreground text-xs">Address</label>
          <input
            id="power-address"
            class={fieldClass}
            placeholder="192.168.1.9"
            spellcheck="false"
            autocomplete="off"
            bind:value={address}
          />
        </div>
        <div class="grid gap-1">
          <label for="power-password" class="text-muted-foreground text-xs">Password</label>
          <input
            id="power-password"
            type="password"
            class={fieldClass}
            autocomplete="off"
            aria-describedby="power-user-note"
            bind:value={password}
          />
          <p id="power-user-note" class="text-muted-foreground text-xs">
            User name is always admin
          </p>
        </div>
        {@render problem()}
        <Dialog.Footer>
          <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}
            >Cancel</Button
          >
          <Button type="submit" size="sm" disabled={busy || !address.trim() || !password}
            >{busy ? 'Connecting…' : 'Connect'}</Button
          >
        </Dialog.Footer>
      </form>
    {:else if step === 'choose'}
      <div class="grid gap-3">
        <h4 bind:this={heading} tabindex="-1" class={headingClass}>Choose the plug</h4>
        <fieldset class="grid gap-1.5" disabled={busy}>
          <legend class="sr-only">Plugs that measure power</legend>
          {#each devices as d (d.id)}
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="power-plug" value={d.id} bind:group={chosen} />
              {label(d)}
            </label>
          {:else}
            <p class="text-muted-foreground text-xs">
              No plug that measures power is paired with this switch yet.
            </p>
          {/each}
        </fieldset>
        <div class="grid gap-1.5">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={() => void pair()}>Pair a new plug…</Button
            >
          </div>
          <p class="text-muted-foreground text-xs">
            Hold the plug's button for 5 seconds until its LED blinks fast. Threadgarden waits up to
            a minute, and pairing can't be cancelled, only waited out.
          </p>
          {#if pairLeft !== null}
            <p class="text-xs" role="status">Waiting for a new plug… {pairLeft} s</p>
          {/if}
          {#if pairNotice}<p class="text-xs" role="status">{pairNotice}</p>{/if}
        </div>
        {@render problem()}
        <Dialog.Footer>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={() => void goto('connect')}>Back</Button
          >
          <Button
            type="button"
            size="sm"
            disabled={busy || !device}
            onclick={() => void goto('check')}>Next</Button
          >
        </Dialog.Footer>
      </div>
    {:else}
      <form
        class="grid gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h4 bind:this={heading} tabindex="-1" class={headingClass}>Check</h4>
        {#if isPlug}
          <p class="text-xs">
            <span class="rounded border px-1 py-0.5 font-medium">Experimental</span>
            <span class="text-muted-foreground">A Wi-Fi plug running Tasmota.</span>
          </p>
        {/if}
        <div class="flex items-center justify-between gap-2 text-sm">
          <p aria-live="polite">Now drawing {wattsText(live)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || refreshLocked}
            onclick={() => void refresh()}>Refresh</Button
          >
        </div>
        <p class="text-muted-foreground text-xs">
          Turn the machine on and let it run, then off, and see that the number falls.
        </p>
        <div class="grid grid-cols-2 gap-2">
          <div class="grid gap-1">
            <label for="power-off-watts" class="text-muted-foreground text-xs">Off below (W)</label>
            <input
              id="power-off-watts"
              class={fieldClass}
              inputmode="decimal"
              bind:value={offWatts}
              aria-invalid={!offOk}
            />
          </div>
          <div class="grid gap-1">
            <label for="power-wait" class="text-muted-foreground text-xs"
              >Wait before switching on (s)</label
            >
            <input
              id="power-wait"
              class={fieldClass}
              inputmode="numeric"
              bind:value={minOffSeconds}
              aria-invalid={!waitOk}
            />
          </div>
        </div>
        <p class="text-muted-foreground text-xs">
          The machine counts as off below that many watts. Off is 0.5 to 100 W; the wait is 10 to
          600 seconds.
        </p>
        {@render problem()}
        <Dialog.Footer>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={() => void goto(isPlug ? 'connect' : 'choose')}>Back</Button
          >
          <Button type="submit" size="sm" disabled={busy || !offOk || !waitOk}>Save</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>

{#snippet problem()}
  <div aria-live="polite">
    {#if failure}
      <div class="text-destructive text-xs" role="alert">
        {#if 'list' in failure}
          <ul class="list-disc pl-4">
            {#each failure.list as p (p)}<li>{p}</li>{/each}
          </ul>
        {:else}
          <p>{failure.text}</p>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}
