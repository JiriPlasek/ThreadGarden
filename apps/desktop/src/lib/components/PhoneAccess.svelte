<script lang="ts">
  import type { Device, PhoneAccess } from '@threadgarden/protocol';
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
   */
  let { onStartAtSignIn }: { onStartAtSignIn?: () => void } = $props();

  const { scopes, settings } = useApp();
  const api = scopes.local().api;

  const SETTING = 'Let my phone connect';
  const HELP =
    "Your phone can use this PC's chats, on your private network. Windows may ask to allow it. After a restart, this PC is reachable once someone signs in.";

  let access = $state<PhoneAccess | null>(null);
  let devices = $state.raw<Device[]>([]);
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
    } catch {
      devices = [];
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
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
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

  const toggle = (e: Event & { currentTarget: HTMLInputElement }): void => {
    const want = e.currentTarget.checked;
    // The box shows the service's state, not the click, until it answers.
    e.currentTarget.checked = access?.enabled ?? false;
    if (!want && devices.length > 0) {
      askOff = true;
      return;
    }
    void set(want);
  };

  const showCode = async (): Promise<void> => {
    error = null;
    expired = false;
    try {
      code = await api.request('pairing.create', {});
    } catch (err) {
      error = text(err);
    }
  };

  const remove = async (d: Device): Promise<void> => {
    await api.request('devices.revoke', { deviceId: d.id });
    await loadDevices();
  };

  const startAtSignIn = async (): Promise<void> => {
    starting = true;
    error = null;
    try {
      await setAutostart(true);
      await settings.update({ startOnLogin: true });
      onStartAtSignIn?.();
    } catch (err) {
      error = text(err);
    } finally {
      starting = false;
    }
  };

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
        onchange={toggle}
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
        {#if code}
          <span class="font-mono text-base font-semibold tracking-wider">{code.code}</span>
          <span class="text-muted-foreground text-xs">Expires in {left}</span>
        {:else if expired}
          <span class="text-muted-foreground text-xs">The code has expired.</span>
        {/if}
      </div>

      {#if !settings.value.startOnLogin}
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
