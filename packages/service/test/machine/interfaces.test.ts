import { describe, expect, it } from 'vitest';
import { privateListenAddresses } from '../../src/machine/interfaces';

describe('privateListenAddresses', () => {
  it('listens only on private IPv4 addresses', () => {
    expect(
      privateListenAddresses({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        wlan0: [
          { address: '192.168.1.40', family: 'IPv4', internal: false } as never,
          { address: 'fe80::1', family: 'IPv6', internal: false } as never,
        ],
        tun0: [{ address: '100.64.3.2', family: 'IPv4', internal: false } as never],
        eth9: [
          { address: '85.70.1.2', family: 'IPv4', internal: false } as never,
          { address: '172.32.0.1', family: 'IPv4', internal: false } as never,
        ],
      }),
    ).toEqual(['100.64.3.2', '192.168.1.40']);
  });

  it('covers range edges, de-duplicates and sorts', () => {
    const v4 = (address: string) => ({ address, family: 'IPv4', internal: false }) as never;
    expect(
      privateListenAddresses({
        a: [v4('172.16.0.1'), v4('172.31.255.254'), v4('100.127.255.255'), v4('100.128.0.1')],
        b: [
          v4('10.0.0.9'),
          v4('10.0.0.10'),
          v4('10.0.0.9'),
          v4('100.63.255.255'),
          v4('172.15.0.1'),
        ],
        c: undefined,
      }),
    ).toEqual(['10.0.0.9', '10.0.0.10', '100.127.255.255', '172.16.0.1', '172.31.255.254']);
  });
});
