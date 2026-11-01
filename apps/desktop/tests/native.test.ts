import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json';

// Browser mode (no Tauri runtime): native.ts falls back to stubs that read the mock service URL.
const load = async () => {
  vi.resetModules();
  return import('../src/lib/native');
};

describe('native (browser stubs)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('native stubs return mock connection in browser', async () => {
    vi.stubEnv('VITE_THREADGARDEN_MOCK_URL', 'ws://127.0.0.1:7357');
    vi.stubEnv('VITE_THREADGARDEN_MOCK_TOKEN', 'mock-token');
    const native = await load();
    expect(native.isTauri).toBe(false);
    // Mock mode has no app/service version pairing: both report the app's version.
    await expect(native.serviceConnection()).resolves.toEqual({
      port: 7357,
      token: 'mock-token',
      serviceVersion: pkg.version,
      appVersion: pkg.version,
    });
  });

  it('rejects with a clear error when no mock service is configured', async () => {
    vi.stubEnv('VITE_THREADGARDEN_MOCK_URL', '');
    vi.stubEnv('VITE_THREADGARDEN_MOCK_TOKEN', '');
    const native = await load();
    await expect(native.serviceConnection()).rejects.toThrow(/VITE_THREADGARDEN_MOCK_URL/);
  });

  it('keeps the API key in memory only', async () => {
    const native = await load();
    await expect(native.apiKey.get()).resolves.toBeNull();
    await native.apiKey.set('sk-test');
    await expect(native.apiKey.get()).resolves.toBe('sk-test');
    await native.apiKey.clear();
    await expect(native.apiKey.get()).resolves.toBeNull();
  });

  it('keeps machine device tokens in memory only, per machine', async () => {
    const native = await load();
    await expect(native.machineTokens.get('m1')).resolves.toBeNull();
    await native.machineTokens.set('m1', 'tok1');
    await native.machineTokens.set('m2', 'tok2');
    await expect(native.machineTokens.get('m1')).resolves.toBe('tok1');
    await native.machineTokens.clear('m1');
    await expect(native.machineTokens.get('m1')).resolves.toBeNull();
    await expect(native.machineTokens.get('m2')).resolves.toBe('tok2');
    await expect(native.apiKey.get()).resolves.toBeNull();
  });

  it('keeps power switch passwords in memory only, apart from device tokens', async () => {
    const native = await load();
    await expect(native.powerPasswords.get('m1')).resolves.toBeNull();
    await native.powerPasswords.set('m1', 'pw1');
    await native.powerPasswords.set('m2', 'pw2');
    await expect(native.powerPasswords.get('m1')).resolves.toBe('pw1');
    await expect(native.machineTokens.get('m1')).resolves.toBeNull();
    await native.powerPasswords.clear('m1');
    await expect(native.powerPasswords.get('m1')).resolves.toBeNull();
    await expect(native.powerPasswords.get('m2')).resolves.toBe('pw2');
  });

  it('makes native-only calls harmless no-ops', async () => {
    const native = await load();
    const unlisten = await native.onTray('stop-all', () => {});
    expect(typeof unlisten).toBe('function');
    unlisten();
    await expect(native.pickFolder()).resolves.toBeNull();
    await expect(native.setTrayNeedsYou(3)).resolves.toBeUndefined();
    await expect(native.notify('t', 'b', 'machine-1/s1')).resolves.toBeUndefined();
    await expect(native.setAutostart(true)).resolves.toBeUndefined();
    await expect(native.quitApp()).resolves.toBeUndefined();
  });
});

describe('openExternal (browser dev fallback)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens http(s) in a new browsing context and ignores other targets', async () => {
    const native = await load();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await expect(native.openExternal('https://example.com')).resolves.toBe(true);
    await expect(native.openExternal('mailto:a@b.example')).resolves.toBe(false);
    await expect(native.openExternal('javascript:alert(1)')).resolves.toBe(false);
    expect(open.mock.calls).toEqual([['https://example.com/', '_blank', 'noopener,noreferrer']]);
  });
});
