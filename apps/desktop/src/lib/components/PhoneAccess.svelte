<script lang="ts">
  import type { Device, PhoneAccess } from '@threadgarden/protocol';
  import { untrack } from 'svelte';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { setAutostart } from '#lib/native.js';
  import { quietly } from '#lib/state/api.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * Settings → Machines → Let my phone connect (phone plan, Task 4): This PC
   * listens for a paired phone on its private addresses (`phoneAccess.*`, local
   * only, never part of the dialog's Save). On, it shows where it listens, a
   * one-time pairing code on request, and the phones paired with it. Turning
   * it off disconnects them at once, so with a phone paired it asks first.
   *
   * Threadgarden must run for the phone to connect: on offers Start at
   * sign-in (the desktop's autostart), and never turns it on by itself.
   * A service without the setting (older) shows nothing.
   *
   * No event says a phone paired, so the list is read again when a code is
   * shown, every few seconds while it's live, at its end, and before turning
   * off. A list that can't be read keeps what it had, and turning off then
   * asks, as it would with a phone paired.
   */
  let {
    onStartAtSignIn,
    startOnLogin = false,
  }: {
    onStartAtSignIn?: () => void;
    /** The dialog's form has Start on login ticked (saved or not). */
    startOnLogin?: boolean;
  } = $props();

  /** How often the paired devices are read while a code is live. */
  const DEVICES_POLL_MS = 3_000;

  const { scopes, settings } = useApp();
  const api = scopes.local().api;

  const SETTING = 'Let my phone connect';
  const HELP =
    "Your phone can use this PC's chats, on your private network. Windows may ask to allow it. After a restart, this PC is reachable once someone signs in.";

  let access = $state<PhoneAccess | null>(null);
  let devices = $state.raw<Device[]>([]);
  /** The last read of the devices failed: who is paired isn't known. */
  let devicesUnknown = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let code = $state<{ code: string; expiresAt: number } | null>(null);
  let expired = $state(false);
  let now = $state(Date.now());
  let askOff = $state(false);
  let removing = $state<Device | null>(null);
  let removeOpen = $state(false);
  let starting = $state(false);

  const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const loadDevices = async (): Promise<void> => {
    try {
      devices = await api.request('devices.list', {});
      devicesUnknown = false;
    } catch {
      // The phones it had stay listed.
      devicesUnknown = true;
    }
  };

  const apply = (next: PhoneAccess): void => {
    const was = access?.enabled ?? false;
    access = next;
    if (next.enabled) {
      if (!was) quietly(loadDevices());
    } else {
      code = null;
      expired = false;
    }
  };

  $effect(() => {
    let live = true;
    api
      .request('phoneAccess.get', {})
      .then((a) => {
        if (live) apply(a);
      })
      .catch(() => {
        // An older service: no such setting.
      });
    const off = api.on('phoneAccess.changed', (a) => apply(a));
    return () => {
      live = false;
      off();
    };
  });

  // The code's countdown, and its end.
  $effect(() => {
    if (!code) return;
    const tick = (): void => {
      now = Date.now();
      if (code && now >= code.expiresAt) {
        code = null;
        expired = true;
        // A phone may have paired at the last moment.
        quietly(loadDevices());
      }
    };
    // Untracked: the clock it sets must not start this again (the poll would never fire).
    untrack(tick);
    const t = setInterval(tick, 250);
    // A phone pairing with it: no event says so.
    const poll = setInterval(() => quietly(loadDevices()), DEVICES_POLL_MS);
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  });

  const set = async (enabled: boolean): Promise<void> => {
    busy = true;
    error = null;
    try {
      apply(await api.request('phoneAccess.set', { enabled }));
    } catch (err) {
      error = text(err);
    } finally {
      busy = false;
    }
  };

  const toggle = async (e: Event & { currentTarget: HTMLInputElement }): Promise<void> => {
    const want = e.currentTarget.checked;
    // The box shows the service's state, not the click, until it answers.
    e.currentTarget.checked = access?.enabled ?? false;
    if (!want) {
      // Who is paired now, not when the list was last read.
      await loadDevices();
      if (devices.length > 0 || devicesUnknown) {
        askOff = true;
        return;
      }
    }
    await set(want);
  };

  const showCode = async (): Promise<void> => {
    error = null;
    expired = false;
    try {
      code = await api.request('pairing.create', {});
    } catch (err) {
      error = text(err);
    }
    await loadDevices();
  };

  const remove = async (d: Device): Promise<void> => {
    await api.request('devices.revoke', { deviceId: d.id });
    await loadDevices();
  };

  const startAtSignIn = async (): Promise<void> => {
    starting = true;
    error = null;
    try {
      // The setting first: should autostart fail, it is put back.
      await settings.update({ startOnLogin: true });
      try {
        await setAutostart(true);
      } catch (err) {
        await settings.update({ startOnLogin: false }).catch(() => {});
        throw err;
      }
      onStartAtSignIn?.();
    } catch (err) {
      error = text(err);
    } finally {
      starting = false;
    }
  };

  /** When the code ends, said once (the countdown beside it is not announced). */
  const until = $derived(
    code
      ? new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '',
  );

  const left = $derived.by(() => {
    if (!code) return '';
    const s = Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  const seen = (d: Device): string =>
    d.lastSeen === null
      ? 'Never connected'
      : `Last connected ${new Date(d.lastSeen).toLocaleString()}`;
</script>

{#if access}
  <div class="grid min-w-0 gap-2 rounded-md border p-2" role="group" aria-label={SETTING}>
    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={access.enabled}
        disabled={busy}
        aria-describedby="phone-access-help"
        onchange={(e) => void toggle(e)}
      />
      {SETTING}
    </label>
    <p id="phone-access-help" class="text-muted-foreground text-xs">{HELP}</p>

    {#if access.enabled}
      {#if access.addresses.length > 0}
        <div class="text-xs">
          <p class="text-muted-foreground">Your phone connects to this PC at:</p>
          <ul class="font-mono" aria-label="Addresses">
            {#each access.addresses as address (address)}
              <li>{address}:{access.port}</li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="text-muted-foreground text-xs">
          This PC has no private network address right now.
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => void showCode()}
          >Show a pairing code</Button
        >
        <!-- Said once: the code and when it ends; the countdown beside it is for the eye. -->
        <span role="status" aria-live="polite" class="flex flex-wrap items-center gap-2">
          {#if code}
            <span class="font-mono text-base font-semibold tracking-wider">{code.code}</span>
            <span class="sr-only">Expires at {until}</span>
          {:else if expired}
            <span class="text-muted-foreground text-xs">The code has expired.</span>
          {/if}
        </span>
        {#if code}
          <span class="text-muted-foreground text-xs" aria-hidden="true">Expires in {left}</span>
        {/if}
      </div>

      {#if !settings.value.startOnLogin && !startOnLogin}
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-muted-foreground"
            >Your phone connects only while Threadgarden runs.</span
          >
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onclick={() => void startAtSignIn()}>Start at sign-in</Button
          >
        </div>
      {/if}

      {#if devices.length > 0}
        <ul class="grid gap-1 text-xs" aria-label="Paired devices">
          {#each devices as d (d.id)}
            <li class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 truncate">
                <span class="text-sm">{d.name}</span>
                <span class="text-muted-foreground"> · {seen(d)}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                class="text-destructive"
                aria-label="Remove {d.name}"
                onclick={() => {
                  removing = d;
                  removeOpen = true;
                }}>Remove</Button
              >
            </li>
          {/each}
        </ul>
      {/if}

      <p class="text-muted-foreground text-xs">
        Turning it off disconnects your phone; it stays paired.
      </p>
    {/if}

    <div aria-live="polite">
      {#if error}<p class="text-destructive text-xs" role="alert">{error}</p>{/if}
    </div>
  </div>
{/if}

<ConfirmDialog
  bind:open={askOff}
  title="Turn off {SETTING}?"
  description="Your phone disconnects now, and can't connect again until you turn this back on. It stays paired."
  confirmLabel="Turn off"
  destructive
  onConfirm={() => set(false)}
/>

<ConfirmDialog
  bind:open={removeOpen}
  title={`Remove ${removing?.name ?? ''}?`}
  description={`${removing?.name ?? 'The device'} can no longer connect to this PC. To use it again, pair it again.`}
  confirmLabel="Remove"
  destructive
  onConfirm={() => (removing ? remove(removing) : undefined)}
/>
