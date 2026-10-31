/** The longest device name a machine accepts at pairing (`pair.claim`). */
export const DEVICE_NAME_MAX = 60;

/**
 * The name this PC offers when pairing with another machine: its host name
 * without the domain part, cut to what pairing accepts, else `fallback`.
 */
export const deviceNameFrom = (hostname: string | null | undefined, fallback: string): string => {
  const short = (hostname ?? '').split('.')[0]!.trim().slice(0, DEVICE_NAME_MAX).trim();
  return short || fallback;
};
