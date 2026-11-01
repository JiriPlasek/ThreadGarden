import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  POWER_CAPABILITY,
  PowerConfigSchema,
  SettingsSchema,
  acceptsRemoteProtocol,
  events,
  methods,
} from '../src/index.js';

describe('power protocol', () => {
  it('defaults the power config', () => {
    const c = PowerConfigSchema.parse({
      kind: 'tasmota-zigbee',
      address: '192.168.1.106',
      device: 'UbuntuPlug',
    });
    expect(c.offWatts).toBe(5);
    expect(c.minOffSeconds).toBe(90);
    expect(c.measured).toEqual({ running: null, standby: null });
  });

  it('rejects a too-short minimum off time', () => {
    const r = PowerConfigSchema.safeParse({
      kind: 'tasmota-plug',
      address: 'x',
      device: null,
      minOffSeconds: 5,
    });
    expect(r.success).toBe(false);
  });

  it('has the methods and the event', () => {
    expect(methods['power.shutdown']).toBeDefined();
    expect(events['power.changed']).toBeDefined();
  });

  it('allows never for idle shutdown, default 60', () => {
    expect(SettingsSchema.shape.idleShutdownMinutes.parse(null)).toBeNull();
    expect(SettingsSchema.parse({}).idleShutdownMinutes).toBe(60);
  });

  it('is protocol 6 and accepts machines at 5 to 7', () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect([4, 5, 6, 7, 8].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
    expect(POWER_CAPABILITY).toBe('power');
    expect(CAPABILITIES).not.toContain('power');
  });
});
