/**
 * Getting an Off machine on before something is done with it (Move to…, an
 * update): its power control turns it on, then its link is waited for.
 */
import { machineNameOf, type MachinesState } from './machines.svelte';
import type { PowerState } from './power.svelte';

/** How often it looks whether a machine is on meanwhile. */
const ON_POLL_MS = 1_000;

export const pause = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

type Waiting = {
  machines: Pick<MachinesState, 'get'>;
  /** Throws when the wait is over (e.g. an abandoned move). */
  alive?: () => void;
};

const isOnIn = (machines: Pick<MachinesState, 'get'>, id: string): boolean =>
  machines.get(id)?.status === 'on';

/** Waits until machine `id` is on, at most `ms`; false when it did not come. */
export const waitUntilOn = async (w: Waiting, id: string, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    w.alive?.();
    if (isOnIn(w.machines, id)) return true;
    if (Date.now() >= deadline) return false;
    await pause(ON_POLL_MS);
  }
};

/** Turns an Off machine on and waits until its link is on; throws when it does not come up. */
export const bringUp = async (
  app: {
    machines: Pick<MachinesState, 'get' | 'shown'>;
    power: Pick<PowerState, 'turnOn' | 'error'>;
  },
  id: string,
  opts: { waitMs: number; alive?: () => void },
): Promise<void> => {
  const { machines, power } = app;
  if (isOnIn(machines, id)) return;
  const name = machineNameOf(machines, id);
  const m = machines.get(id);
  const shown = m ? machines.shown(m) : 'unreachable';
  if (shown !== 'off' && shown !== 'starting') throw new Error(`${name} can't be reached`);
  if (shown === 'off') {
    const turnedOn = await power.turnOn(id);
    opts.alive?.();
    if (!turnedOn) throw new Error(power.error(id) ?? `${name} couldn't be turned on`);
  }
  if (!(await waitUntilOn({ machines, alive: opts.alive }, id, opts.waitMs))) {
    throw new Error(`${name} didn't come up in ${Math.round(opts.waitMs / 60_000)} minutes`);
  }
};
