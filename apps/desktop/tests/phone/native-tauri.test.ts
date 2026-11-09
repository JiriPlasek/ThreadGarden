import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Inside Tauri (mocked): the phone and desktop gates choose between real commands.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
    void [cmd, args];
    return null;
  }),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: tauri.invoke }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, h: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, h);
    return () => events.handlers.delete(name);
  }),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: tauri.sendNotification,
}));

const load = async () => {
  vi.resetModules();
  return import('../../src/lib/native');
};

const realAgent = navigator.userAgent;
const setAgent = (ua: string) =>
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });

describe('native in Tauri, phone or desktop', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_THREADGARDEN_PHONE', '');
    vi.stubEnv('TAURI_ENV_PLATFORM', 'linux');
    tauri.invoke.mockClear();
    tauri.sendNotification.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setAgent(realAgent);
  });

  it("TAURI_ENV_PLATFORM='android' makes a phone build", async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android');
    expect((await load()).isPhone).toBe(true);
  });

  it('an Android webview is the phone even when the build said nothing', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', '');
    setAgent('Mozilla/5.0 (Linux; Android 16; Phone) AppleWebKit/537.36 Chrome/140 Mobile');
    expect((await load()).isPhone).toBe(true);
    setAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)');
    expect((await load()).isPhone).toBe(false);
  });

  it('the desktop posts notifications and uses its tray, keychain and updater', async () => {
    const native = await load();
    expect(native.isPhone).toBe(false);
    await native.notify('t', 'b', 'm1/s1');
    expect(tauri.sendNotification).toHaveBeenCalledOnce();
    await native.setTrayNeedsYou(2);
    await native.machineTokens.get('m1');
    await native.updater.installKind();
    await native.setActiveChat('m1', 's1');
    const commands = tauri.invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands).toEqual(['set_tray_needs_you', 'machine_token_get', 'install_kind']);
  });

  it("the phone posts nothing and calls none of the desktop's commands; the core hears the open chat", async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android');
    const native = await load();
    await native.notify('t', 'b', 'm1/s1');
    expect(tauri.sendNotification).not.toHaveBeenCalled();
    await native.setTrayNeedsYou(2);
    await expect(native.machineTokens.get('m1')).resolves.toBeNull();
    await native.machineTokens.set('m1', 'tok');
    await expect(native.apiKey.get()).resolves.toBeNull();
    await expect(native.powerPasswords.get('m1')).resolves.toBeNull();
    await expect(native.updater.installKind()).resolves.toBe('unsupported');
    await expect(native.updater.check()).resolves.toBeNull();
    await native.setAutostart(true);
    await native.stopService();
    await native.setActiveChat('m1', 's1');
    expect(tauri.invoke.mock.calls).toEqual([
      ['alerts_set_active', { machineId: 'm1', sessionId: 's1' }],
    ]);
  });

  it('an alert that started the app opens its chat once the screens listen, and later ones as they come', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android');
    let waiting: unknown = { machineId: 'm1', sessionId: 's1' };
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== 'alerts_take_open') return null;
      const w = waiting;
      waiting = null;
      return w;
    });
    const native = await load();
    const opened: unknown[] = [];
    const off = await native.onOpenChat((c) => opened.push(c));
    expect(opened).toEqual([{ machineId: 'm1', sessionId: 's1' }]);
    events.handlers.get('alerts://open')?.({ payload: { machineId: 'm1', sessionId: 's2' } });
    expect(opened).toEqual([
      { machineId: 'm1', sessionId: 's1' },
      { machineId: 'm1', sessionId: 's2' },
    ]);
    off();
    expect(events.handlers.has('alerts://open')).toBe(false);
    tauri.invoke.mockImplementation(async () => null);
  });

  it("the phone's keep-alive commands reach the shell; the desktop has none", async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android');
    let native = await load();
    await native.keepAlive.status();
    await native.keepAlive.requestBatteryExemption();
    await native.keepAlive.disconnect();
    await native.keepAlive.connect();
    expect(tauri.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      'keep_alive_status',
      'request_battery_exemption',
      'disconnect',
      'connect',
    ]);
    tauri.invoke.mockClear();
    vi.stubEnv('TAURI_ENV_PLATFORM', 'linux');
    native = await load();
    await expect(native.keepAlive.status()).resolves.toEqual({
      notificationsAllowed: true,
      batteryExempt: true,
      connected: true,
    });
    await native.keepAlive.disconnect();
    const off = await native.onOpenChat(() => {});
    off();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
