import { describe, expect, it } from 'vitest';
import { DEVICE_NAME_MAX, deviceNameFrom } from '../../src/lib/device-name';

describe('deviceNameFrom', () => {
  it('keeps a short host name', () => {
    expect(deviceNameFrom('my-host', 'This PC')).toBe('my-host');
  });

  it('drops the domain part', () => {
    expect(deviceNameFrom('Jiris-MacBook-Pro.local', 'This PC')).toBe('Jiris-MacBook-Pro');
  });

  it('cuts a long host name to what pairing accepts', () => {
    const long = 'sat12-bc009-' + 'x'.repeat(80);
    const name = deviceNameFrom(long, 'This PC');
    expect(name).toHaveLength(DEVICE_NAME_MAX);
    expect(long.startsWith(name)).toBe(true);
  });

  it('falls back when there is no usable name', () => {
    expect(deviceNameFrom(undefined, 'This PC')).toBe('This PC');
    expect(deviceNameFrom('', 'This PC')).toBe('This PC');
    expect(deviceNameFrom('.local', 'This PC')).toBe('This PC');
  });
});
