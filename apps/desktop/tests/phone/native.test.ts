import { afterEach, describe, expect, it, vi } from 'vitest';

// Browser mode: the phone is told by `VITE_THREADGARDEN_PHONE=1` (Android builds by Tauri's platform).
const load = async () => {
  vi.resetModules();
  return import('../../src/lib/native');
};

describe('native on the phone', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a desktop build is not the phone', async () => {
    vi.stubEnv('VITE_THREADGARDEN_PHONE', '');
    const native = await load();
    expect(native.isPhone).toBe(false);
    expect(native.machineTokens.heldByCore).toBe(false);
    await native.machineTokens.set('m1', 'tok');
    await expect(native.machineTokens.get('m1')).resolves.toBe('tok');
  });

  it('VITE_THREADGARDEN_PHONE=1 makes a phone build, whose core holds the tokens', async () => {
    vi.stubEnv('VITE_THREADGARDEN_PHONE', '1');
    const native = await load();
    expect(native.isPhone).toBe(true);
    expect(native.machineTokens.heldByCore).toBe(true);
    await native.machineTokens.set('m1', 'tok');
    await expect(native.machineTokens.get('m1')).resolves.toBeNull();
    await expect(native.machineTokens.clear('m1')).resolves.toBeUndefined();
    await expect(native.apiKey.get()).resolves.toBeNull();
    await expect(native.updater.installKind()).resolves.toBe('unsupported');
    // In a browser: nothing to tell (native-tauri.test.ts covers the Tauri side).
    await expect(native.setActiveChat('m1', 's1')).resolves.toBeUndefined();
  });
});
