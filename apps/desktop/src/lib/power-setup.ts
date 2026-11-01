/**
 * Plain words and small rules for the power setup (Settings → Machines →
 * Power): what each failed request says, the name given to a newly paired
 * plug, and the suggested "off" line.
 */
import { MIN_TASMOTA, POWER_ERRORS } from '@threadgarden/protocol';
import { RequestError } from './service/client';

/** A failure as the setup shows it: one sentence, or a list (a conflict on the switch). */
export type PowerFailure = { text: string } | { list: string[] };

const minVersion = MIN_TASMOTA.split('.').slice(0, 2).join('.');

/** The plain failure for a request error; `address` is what the owner typed. */
export const powerFailure = (e: unknown, address: string): PowerFailure => {
  if (!(e instanceof RequestError)) {
    return { text: e instanceof Error && e.message ? e.message : 'Something went wrong.' };
  }
  switch (e.code) {
    case POWER_ERRORS.unreachable:
      return {
        text: `Threadgarden couldn't reach the switch at ${address}. Check the address and that it's on.`,
      };
    case POWER_ERRORS.auth:
      return { text: "The switch didn't accept that password." };
    case POWER_ERRORS.notTasmota:
      return { text: "That address doesn't answer like a Tasmota device." };
    case POWER_ERRORS.tooOld: {
      const version = /\d+(?:\.\d+)+/.exec(e.message)?.[0] ?? 'older than that';
      return {
        text: `This switch runs Tasmota ${version}; Threadgarden needs ${minVersion} or newer.`,
      };
    }
    case POWER_ERRORS.refused:
      return {
        text: "The switch refused Threadgarden's request. On its page, Consoles → Console, run SetOption128 1, then try again.",
      };
    case POWER_ERRORS.noMetering:
      return {
        text: "This switch can't measure power, so Threadgarden can't tell when the machine is off.",
      };
    case POWER_ERRORS.conflict: {
      const problems = e.message
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { list: problems.length > 0 ? problems : [e.message] };
    }
    default:
      // notConfigured speaks for itself; so does anything unknown.
      return { text: e.message || 'Something went wrong.' };
  }
};

/** What the service accepts as a Zigbee device name (`isZigbeeName`). */
export const isZigbeeName = (name: string): boolean => /^[A-Za-z0-9_.-]{1,32}$/.test(name);

const tidy = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');

/** `name` made into one the service accepts ("Desk lamp plug" → "Desk_lamp_plug"). */
export const suggestedName = (name: string): string => tidy(tidy(name).slice(0, 32)) || 'plug';

/** The Zigbee name for a plug paired for `machine`: "Ubuntu PC" → "Ubuntu_PC_plug". */
export const plugNameFor = (machine: string): string => {
  // Cut first, then tidy again: no doubled or dangling separator before "_plug".
  const base = tidy(tidy(machine).slice(0, 27));
  return base ? `${base}_plug` : 'plug';
};

/** The plain sentence of a failure, a list joined into one. */
export const failureText = (f: PowerFailure): string => ('list' in f ? f.list.join(' ') : f.text);

/** A suggested "off" line, or null when it would be out of the 0.5 to 100 W range. */
export const offLineSuggestion = (running: number, standby: number): number | null => {
  const watts = suggestOffWatts(running, standby);
  return watts > 100 ? null : watts;
};

/** The "off" line between a PC's standby and lowest running draw, a quarter of the way up (spec §10). */
export const suggestOffWatts = (running: number, standby: number): number =>
  Math.max(2, Math.round(standby + (running - standby) / 4));

/** `47 W` for a reading, or no number when the plug gave none. */
export const wattsText = (watts: number | null): string =>
  watts === null ? 'no reading' : `${Math.round(watts * 10) / 10} W`;
