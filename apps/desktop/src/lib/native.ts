/**
 * Native (Tauri) features behind one module. Inside the Tauri webview every
 * function calls a Rust command or plugin; in a plain browser (tests, UI work
 * against the mock service) harmless stubs stand in, and the service
 * connection comes from `VITE_PAHUB_MOCK_URL` / `VITE_PAHUB_MOCK_TOKEN`.
 */
import { invoke, isTauri as detectTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type ServiceConnection = { port: number; token: string };
export type TrayEvent = 'stop-all' | 'quit-all';

export const isTauri: boolean = detectTauri();

const mockConnection = (): ServiceConnection => {
  const url = import.meta.env.VITE_PAHUB_MOCK_URL as string | undefined;
  const token = import.meta.env.VITE_PAHUB_MOCK_TOKEN as string | undefined;
  if (!url || !token) {
    throw new Error(
      'No pahub service outside the desktop app: set VITE_PAHUB_MOCK_URL and VITE_PAHUB_MOCK_TOKEN (see `pnpm --filter @pahub/service mock`)',
    );
  }
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`VITE_PAHUB_MOCK_URL has no port: ${url}`);
  return { port, token };
};

/** Finds the running service or starts it; rejects with `service-version-mismatch` for an incompatible one. */
export const serviceConnection = async (): Promise<ServiceConnection> =>
  isTauri ? invoke<ServiceConnection>('service_connection') : mockConnection();

let browserApiKey: string | null = null;

/** pahub's optional Anthropic API key, kept in the OS credential store (in memory in a browser). */
export const apiKey = {
  get: async (): Promise<string | null> =>
    isTauri ? invoke<string | null>('api_key_get') : browserApiKey,
  set: async (key: string): Promise<void> => {
    if (isTauri) await invoke('api_key_set', { key });
    else browserApiKey = key;
  },
  clear: async (): Promise<void> => {
    if (isTauri) await invoke('api_key_clear');
    else browserApiKey = null;
  },
};

/** Shows an OS notification; `sessionId` travels along so a click can open that chat. */
export const notify = async (title: string, body: string, sessionId: string): Promise<void> => {
  if (!isTauri) return;
  const n = await import('@tauri-apps/plugin-notification');
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === 'granted';
  if (granted) n.sendNotification({ title, body, extra: { sessionId } });
};

export const copyText = async (s: string): Promise<void> => {
  if (isTauri) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(s);
  } else {
    await navigator.clipboard?.writeText(s);
  }
};

/** Asks the user for a folder; null when cancelled (always null in a browser). */
export const pickFolder = async (): Promise<string | null> => {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
};

/** Number of chats waiting on the user, shown on the tray icon. */
export const setTrayNeedsYou = async (n: number): Promise<void> => {
  if (isTauri) await invoke('set_tray_needs_you', { count: Math.max(0, Math.floor(n)) });
};

/**
 * Tray menu items that need a confirmation in the UI ("Stop all work…",
 * "Quit pahub completely…"). Resolves to an unsubscribe function.
 */
export const onTray = async (event: TrayEvent, cb: () => void): Promise<() => void> =>
  isTauri ? listen(`tray://${event}`, () => cb()) : () => {};

/** Exits the app only; the service and its agents keep running. */
export const quitApp = async (): Promise<void> => {
  if (isTauri) await invoke('app_quit');
};

export const setAutostart = async (on: boolean): Promise<void> => {
  if (!isTauri) return;
  const autostart = await import('@tauri-apps/plugin-autostart');
  if (on) await autostart.enable();
  else await autostart.disable();
};
