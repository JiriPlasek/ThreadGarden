/**
 * Native (Tauri) features behind one module. Inside the Tauri webview every
 * function calls a Rust command or plugin; in a plain browser (tests, UI work
 * against the mock service) harmless stubs stand in, and the service
 * connection comes from `VITE_THREADGARDEN_MOCK_URL` / `VITE_THREADGARDEN_MOCK_TOKEN`.
 *
 * On the phone (`isPhone`) the app has no local machine: the phone's core
 * stands in for the service, holds the machines' tokens and posts the alerts.
 * The desktop's credential store, tray, autostart and updater have no Android
 * commands, so their functions are stubs there.
 */
import { invoke, isTauri as detectTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ImageRef } from '@threadgarden/protocol';
import pkg from '../../package.json';

/**
 * How to reach the service. `serviceVersion` differing from `appVersion` (with a
 * compatible protocol) means an older or newer service is still running: the UI
 * offers "Restart the Threadgarden service to update" (spec §4.2). An incompatible
 * protocol rejects `serviceConnection()` with `service-version-mismatch` instead.
 */
export type ServiceConnection = {
  port: number;
  token: string;
  serviceVersion: string;
  appVersion: string;
};
export type TrayEvent = 'stop-all' | 'quit-all';

export const isTauri: boolean = detectTauri();

/**
 * The phone build, decided by platform and never by window width: Tauri's
 * Android build (`TAURI_ENV_PLATFORM`, which the Tauri CLI sets for the
 * frontend build), or `VITE_THREADGARDEN_PHONE=1` for the browser against the
 * mock service. Tauri on an Android webview counts too, for a frontend built
 * without the CLI's environment.
 */
export const isPhone: boolean =
  import.meta.env.TAURI_ENV_PLATFORM === 'android' ||
  import.meta.env.VITE_THREADGARDEN_PHONE === '1' ||
  (isTauri && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));

/** On the phone in Tauri: a Rust command exists there (in a browser, the stubs stand in). */
const phoneTauri = isPhone && isTauri;
/** In Tauri on a desktop: the desktop's own Rust commands and plugins exist. */
const desktopTauri = isTauri && !isPhone;

/** This build's version (the app and its bundled service share it). */
export const appVersion: string = pkg.version;

const mockConnection = (): ServiceConnection => {
  const url = import.meta.env.VITE_THREADGARDEN_MOCK_URL as string | undefined;
  const token = import.meta.env.VITE_THREADGARDEN_MOCK_TOKEN as string | undefined;
  if (!url || !token) {
    throw new Error(
      'No Threadgarden service outside the desktop app: set VITE_THREADGARDEN_MOCK_URL and VITE_THREADGARDEN_MOCK_TOKEN (see `pnpm --filter @threadgarden/service mock`)',
    );
  }
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`VITE_THREADGARDEN_MOCK_URL has no port: ${url}`);
  // The mock service is not paired with an app build: report the app's own version for both.
  return { port, token, serviceVersion: pkg.version, appVersion: pkg.version };
};

/** Finds the running service or starts it; rejects with `service-version-mismatch` for an incompatible one. */
export const serviceConnection = async (): Promise<ServiceConnection> =>
  isTauri ? invoke<ServiceConnection>('service_connection') : mockConnection();

/**
 * Stops the running service with all its work and resolves once its process
 * has exited ("Restart service", spec §4.2); `serviceConnection()` then starts
 * a fresh one. Works for a service of another protocol version too. A no-op in
 * a browser (the mock service is not restarted).
 */
export const stopService = async (): Promise<void> => {
  // The phone's core is part of the app: there's no service to stop.
  if (desktopTauri) await invoke('service_stop');
};

let browserApiKey: string | null = null;

/**
 * Threadgarden's optional Anthropic API key, kept in the OS credential store
 * (in memory in a browser). The phone runs no chats, so it never has one.
 */
export const apiKey = {
  get: async (): Promise<string | null> =>
    isPhone ? null : isTauri ? invoke<string | null>('api_key_get') : browserApiKey,
  set: async (key: string): Promise<void> => {
    if (isPhone) throw new Error('The phone runs no chats, so it has no API key');
    if (isTauri) await invoke('api_key_set', { key });
    else browserApiKey = key;
  },
  clear: async (): Promise<void> => {
    if (isPhone) return;
    if (isTauri) await invoke('api_key_clear');
    else browserApiKey = null;
  },
};

const browserMachineTokens = new Map<string, string>();

/**
 * A paired machine's device token, kept in the OS credential store (in memory
 * in a browser). On the phone the core holds them (`heldByCore`), since it
 * reconnects without the screens: these are no-ops there, and the UI never
 * unlocks a machine with one.
 */
export const machineTokens = {
  heldByCore: isPhone,
  get: async (id: string): Promise<string | null> =>
    isPhone
      ? null
      : isTauri
        ? invoke<string | null>('machine_token_get', { machineId: id })
        : (browserMachineTokens.get(id) ?? null),
  set: async (id: string, token: string): Promise<void> => {
    if (isPhone) return;
    if (isTauri) await invoke('machine_token_set', { machineId: id, token });
    else browserMachineTokens.set(id, token);
  },
  clear: async (id: string): Promise<void> => {
    if (isPhone) return;
    if (isTauri) await invoke('machine_token_clear', { machineId: id });
    else browserMachineTokens.delete(id);
  },
};

const browserPowerPasswords = new Map<string, string>();

/**
 * A machine's power switch web password, kept in the OS credential store (in
 * memory in a browser). On the phone the core will keep the plug's password
 * (encrypted like the tokens), so nothing is kept here.
 */
export const powerPasswords = {
  get: async (id: string): Promise<string | null> =>
    isPhone
      ? null
      : isTauri
        ? invoke<string | null>('power_password_get', { machineId: id })
        : (browserPowerPasswords.get(id) ?? null),
  set: async (id: string, password: string): Promise<void> => {
    if (isPhone) throw new Error("The phone keeps a plug's password in its own settings");
    if (isTauri) await invoke('power_password_set', { machineId: id, password });
    else browserPowerPasswords.set(id, password);
  },
  clear: async (id: string): Promise<void> => {
    if (isPhone) return;
    if (isTauri) await invoke('power_password_clear', { machineId: id });
    else browserPowerPasswords.delete(id);
  },
};

/**
 * Shows an OS notification. The notification plugin cannot report clicks back
 * (ruling R26): the chat's key (`machineId/sessionId`, see `chatKey`) rides
 * along in `extra` for platforms that might. The window gaining focus is not
 * taken for a click: coming back to the window changes nothing.
 */
export const notify = async (title: string, body: string, chatKey: string): Promise<void> => {
  // On the phone the core alerts, also while the screens are closed.
  if (!desktopTauri) return;
  const n = await import('@tauri-apps/plugin-notification');
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === 'granted';
  if (granted) n.sendNotification({ title, body, extra: { chatKey } });
};

export const copyText = async (s: string): Promise<void> => {
  if (isTauri) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(s);
  } else {
    await navigator.clipboard?.writeText(s);
  }
};

/** The normalised URL when `url` is an absolute http(s) URL with a host, else null. */
const httpUrl = (url: string): string | null => {
  if (!/^https?:\/\//i.test(url.trim())) return null;
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
};

/**
 * Opens a link in the system browser (ruling R23): http(s) only, through the
 * opener plugin (whose capability is scoped to `http(s)://*`); anything else is
 * ignored. In a plain browser (UI development) it opens a new tab instead.
 * Resolves to whether the URL was handed on.
 */
export const openExternal = async (url: string): Promise<boolean> => {
  const href = httpUrl(url);
  if (!href) return false;
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
  } else {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  return true;
};

/** Asks the user for a folder; null when cancelled (always null in a browser). */
export const pickFolder = async (): Promise<string | null> => {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
};

/** Asks the user for a file (e.g. the Claude Code executable); null when cancelled (always null in a browser). */
export const pickFile = async (): Promise<string | null> => {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: false, multiple: false });
  return typeof picked === 'string' ? picked : null;
};

export type DropPoint = { x: number; y: number };
export type FileDropHandlers = {
  /** Files were dropped at `point` (CSS pixels of the viewport). */
  drop: (paths: string[], point: DropPoint) => void;
  over: (point: DropPoint) => void;
  leave: () => void;
};

/**
 * Native file drag and drop (ruling R24): the desktop webview receives OS
 * drops as paths. Resolves to an unsubscribe function; a no-op in a browser,
 * where the composer handles HTML5 image drops instead.
 */
export const onFileDrop = async (h: FileDropHandlers): Promise<() => void> => {
  // The phone attaches images through the picker only.
  if (!desktopTauri) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    const scale = window.devicePixelRatio || 1;
    const at = (pos: { x: number; y: number }): DropPoint => ({
      x: pos.x / scale,
      y: pos.y / scale,
    });
    if (p.type === 'drop') h.drop(p.paths, at(p.position));
    else if (p.type === 'enter' || p.type === 'over') h.over(at(p.position));
    else h.leave();
  });
};

/**
 * Reads an image from the latest native file drop (PNG, JPEG, GIF, WebP,
 * at most 5 MB; checked by the shell before reading). Rejects with a code:
 * `too-large`, `unsupported-type`, `not-dropped`, `not-a-file`, `read-failed: …`.
 */
export const readDroppedImage = async (path: string): Promise<ImageRef> => {
  if (!isTauri) throw new Error('read-failed: dropped files need the desktop app');
  return invoke<ImageRef>('read_dropped_image', { path });
};

/**
 * The chat in front of the owner (null: none, or the app is in the
 * background). On the phone the core is told, so it doesn't alert for the chat
 * being read; elsewhere a no-op, since the webview's own notifications check it.
 */
export const setActiveChat = async (
  machineId: string | null,
  sessionId: string | null,
): Promise<void> => {
  if (phoneTauri) await invoke('alerts_set_active', { machineId, sessionId });
};

type OpenedChat = { machineId: string; sessionId: string };

/**
 * The phone: the owner opened an alert, and the chat it names is to be shown.
 * The app says so with the `alerts://open` event. An alert that started the
 * app came before anything listened: it waits in the shell, and is taken once
 * the listener is up. Each event takes it too, so later screens don't show it
 * again, and an event while that first take is on its way wins: the waiting
 * chat is the same or older, so it isn't shown as well. Elsewhere nothing
 * opens a chat. Resolves to an unsubscribe function.
 */
export const onOpenChat = async (cb: (chat: OpenedChat) => void): Promise<() => void> => {
  if (!phoneTauri) return () => {};
  const take = (): Promise<OpenedChat | null> => invoke<OpenedChat | null>('alerts_take_open');
  let heard = false;
  const off = await listen<OpenedChat>('alerts://open', (e) => {
    heard = true;
    cb(e.payload);
    void take().catch(() => {});
  });
  const waiting = await take().catch(() => null);
  if (waiting && !heard) cb(waiting);
  return off;
};

/** Whether the phone can stay connected: what Android allows, and Disconnect. */
export type KeepAliveStatus = {
  notificationsAllowed: boolean;
  batteryExempt: boolean;
  /** The alert links are on (the owner didn't choose Disconnect). */
  connected: boolean;
};

/**
 * The phone's foreground service and its links to the machines. Elsewhere
 * there's none: always "connected", nothing to ask.
 */
export const keepAlive = {
  status: async (): Promise<KeepAliveStatus> =>
    phoneTauri
      ? invoke<KeepAliveStatus>('keep_alive_status')
      : { notificationsAllowed: true, batteryExempt: true, connected: true },
  /** Android's own dialog for the battery exemption. */
  requestBatteryExemption: async (): Promise<void> => {
    if (phoneTauri) await invoke('request_battery_exemption');
  },
  /** As the notification's Disconnect: the links close and the notification goes. */
  disconnect: async (): Promise<void> => {
    if (phoneTauri) await invoke('disconnect');
  },
  connect: async (): Promise<void> => {
    if (phoneTauri) await invoke('connect');
  },
};

/** Number of chats waiting on the user, shown on the tray icon (the phone has none). */
export const setTrayNeedsYou = async (n: number): Promise<void> => {
  if (desktopTauri) await invoke('set_tray_needs_you', { count: Math.max(0, Math.floor(n)) });
};

/**
 * Tray menu items that need a confirmation in the UI ("Stop all work…",
 * "Quit Threadgarden completely…"). Resolves to an unsubscribe function.
 */
export const onTray = async (event: TrayEvent, cb: () => void): Promise<() => void> =>
  desktopTauri ? listen(`tray://${event}`, () => cb()) : () => {};

/** Exits the app only; the service and its agents keep running. */
export const quitApp = async (): Promise<void> => {
  if (isTauri) await invoke('app_quit');
};

export const setAutostart = async (on: boolean): Promise<void> => {
  if (!desktopTauri) return;
  const autostart = await import('@tauri-apps/plugin-autostart');
  if (on) await autostart.enable();
  else await autostart.disable();
};

/** How this app was installed, which decides whether it can update itself. */
export type InstallKind = 'windows' | 'macos' | 'appimage' | 'linux-package' | 'unsupported';

/** A newer release found by `updater.check`. */
export type UpdateHandle = {
  version: string;
  notes: string | null;
  /** Downloads and verifies the update against the bundled public key; rejects when either fails. */
  download(onProgress: (done: number, total: number | null) => void): Promise<void>;
  /** Installs a downloaded update (on Windows the installer then exits the app). */
  install(): Promise<void>;
};

export type Updater = {
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
  installKind(): Promise<InstallKind>;
};

/**
 * Self-update from GitHub Releases (the updater and process plugins). Outside
 * the desktop app nothing is ever found: the phone's update notice is its own.
 */
export const updater: Updater = {
  check: async () => {
    if (!desktopTauri) return null;
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? null,
      download: async (onProgress) => {
        let done = 0;
        let total: number | null = null;
        await update.download((e) => {
          if (e.event === 'Started') total = e.data.contentLength ?? null;
          if (e.event === 'Progress') done += e.data.chunkLength;
          onProgress(done, total);
        });
      },
      install: () => update.install(),
    };
  },
  relaunch: async () => {
    if (!desktopTauri) return;
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
  installKind: async () => (desktopTauri ? invoke<InstallKind>('install_kind') : 'unsupported'),
};
