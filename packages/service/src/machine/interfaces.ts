import type { NetworkInterfaceInfo } from 'node:os';

const toInt = (address: string): number | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
};

// 10/8, 172.16/12, 192.168/16 and 100.64/10 (CGNAT, used by Tailscale-style overlays).
const PRIVATE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [toInt('10.0.0.0')!, 8],
  [toInt('172.16.0.0')!, 12],
  [toInt('192.168.0.0')!, 16],
  [toInt('100.64.0.0')!, 10],
];

const isPrivate = (n: number): boolean =>
  PRIVATE_RANGES.some(
    ([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
  );

/** Addresses the remote listener may bind to: private, non-internal IPv4 only. Never 0.0.0.0. */
export const privateListenAddresses = (ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] => {
  const found = new Map<string, number>();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      const n = toInt(info.address);
      if (n !== null && isPrivate(n)) found.set(info.address, n);
    }
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([address]) => address);
};
