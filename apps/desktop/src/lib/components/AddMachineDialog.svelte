<script lang="ts">
  import { MachineAddressSchema, MachinePortSchema } from '@threadgarden/protocol';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { RequestError } from '#lib/service/client.js';
  import { useApp } from '#lib/state/context.js';
  import { THIS_PC } from '#lib/state/refs.js';

  /**
   * Pairs this PC with another machine (Settings → Machines → Add machine…):
   * its address, the one-time code `threadgarden pair` shows there, and the
   * name this PC goes by on that machine. Errors stay inline; the dialog
   * closes once the machine is paired.
   */
  const { interaction, machines } = useApp();

  const DEFAULT_PORT = 47380;

  let address = $state('');
  let port = $state(String(DEFAULT_PORT));
  let code = $state('');
  let deviceName = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** The name this PC goes by on the other machine: its hostname. */
  const defaultName = (): string => machines.local?.info?.name || THIS_PC;

  let wasOpen = false;
  $effect(() => {
    const open = interaction.addMachineOpen;
    if (open && !wasOpen) {
      address = '';
      port = String(DEFAULT_PORT);
      code = '';
      deviceName = defaultName();
      error = null;
      busy = false;
    }
    wasOpen = open;
  });

  const close = (): void => {
    interaction.addMachineOpen = false;
  };

  const failure = (err: unknown, at: string): string => {
    if (err instanceof RequestError) {
      switch (err.code) {
        case 'PAIRING_UNREACHABLE':
          return `Can't reach ${at}. Is the machine on and Threadgarden running there?`;
        case 'PAIRING_PROOF_FAILED':
          return `The machine at ${at} couldn't prove it knows this code. Nothing was sent. Check the code and the address.`;
        case 'PAIRING_INVALID':
          return "That code isn't valid. Run `threadgarden pair` on the machine for a new one.";
        case 'PAIRING_EXPIRED':
          return 'That code has expired. Run `threadgarden pair` again.';
        case 'PAIRING_SELF':
          return "That's this machine.";
        case 'PAIRING_DUPLICATE': {
          const named = machines.list.find(
            (m) => !m.local && m.address.toLowerCase() === at.toLowerCase(),
          )?.name;
          return `Already paired as ${named ?? err.message}.`;
        }
      }
    }
    return err instanceof Error ? err.message : String(err);
  };

  const submit = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    error = null;
    const a = MachineAddressSchema.safeParse(address);
    if (!a.success) {
      error = 'Enter the machine’s IP address or host name, such as ubuntu-pc.local.';
      return;
    }
    const p = MachinePortSchema.safeParse(Number(port.trim()));
    if (!p.success) {
      error = 'The port is a number from 1 to 65535.';
      return;
    }
    const name = deviceName.trim();
    if (!code.trim()) {
      error = 'Enter the pairing code.';
      return;
    }
    if (!name || name.length > 60) {
      error = 'This device’s name is 1 to 60 characters.';
      return;
    }
    busy = true;
    try {
      await machines.pair({
        address: a.data,
        port: p.data,
        code: code.trim(),
        deviceName: name,
      });
      close();
    } catch (err) {
      error = failure(err, a.data);
    } finally {
      busy = false;
    }
  };

  const fieldClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<Dialog.Root
  open={interaction.addMachineOpen}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="gap-4 p-5 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-base">Add machine</Dialog.Title>
      <Dialog.Description class="text-xs"
        >Pair this PC with another machine running Threadgarden.</Dialog.Description
      >
    </Dialog.Header>

    <form class="grid gap-3" onsubmit={(e) => void submit(e)}>
      <div class="grid gap-1">
        <label for="add-machine-address" class="text-muted-foreground text-xs">Address</label>
        <input
          id="add-machine-address"
          class={fieldClass}
          placeholder="ubuntu-pc.local"
          spellcheck="false"
          autocomplete="off"
          bind:value={address}
        />
      </div>
      <div class="grid gap-1">
        <label for="add-machine-code" class="text-muted-foreground text-xs">Pairing code</label>
        <input
          id="add-machine-code"
          class="{fieldClass} font-mono"
          placeholder="XXXX-XXXX-XXXX"
          spellcheck="false"
          autocomplete="off"
          bind:value={code}
        />
      </div>
      <div class="grid gap-1">
        <label for="add-machine-device" class="text-muted-foreground text-xs"
          >This device's name</label
        >
        <input
          id="add-machine-device"
          class={fieldClass}
          maxlength={60}
          autocomplete="off"
          bind:value={deviceName}
        />
      </div>
      <details class="text-xs">
        <summary class="text-muted-foreground cursor-pointer">More</summary>
        <div class="mt-2 grid gap-1">
          <label for="add-machine-port" class="text-muted-foreground text-xs">Port</label>
          <input
            id="add-machine-port"
            class="{fieldClass} w-28"
            inputmode="numeric"
            bind:value={port}
          />
        </div>
      </details>

      <p class="text-muted-foreground text-xs">
        On the other machine, run <code class="font-mono">threadgarden pair</code>.
      </p>
      <div aria-live="polite">
        {#if error}
          <p class="text-destructive text-xs" role="alert">{error}</p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="outline" size="sm" onclick={close}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Pairing…' : 'Pair'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
