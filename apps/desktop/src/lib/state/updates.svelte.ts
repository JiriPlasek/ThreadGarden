/**
 * Self-update (releases spec §6): checks GitHub Releases shortly after start
 * and every 6 hours, shows what it found, and installs on the owner's OK:
 * download and verify first, then stop the local service (the installer
 * replaces its runtime), install, relaunch. A failure before the service stops
 * changes nothing.
 */
import type { Api } from './api';
import type { InstallKind, UpdateHandle, Updater } from '../native';

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const RELEASES_URL = 'https://github.com/JiriPlasek/ThreadGarden/releases';

/** `uiState` key: the version whose notice was dismissed. */
const DISMISSED_KEY = 'updates.dismissed';

const UNREACHABLE = "Couldn't reach GitHub. Try again later.";
const NOT_DOWNLOADED = "The update couldn't be downloaded or verified. Nothing was changed.";

export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'unsupported';

export type UpdatesDeps = {
  api: Pick<Api, 'request'>;
  updater: Updater;
  appVersion: string;
  /** Stops This PC's service (and its work) so the installer can replace it. */
  stopLocalService(): Promise<void>;
  now?: () => number;
};

export class UpdatesState {
  phase = $state<UpdatePhase>('idle');
  current = $state('');
  available = $state<{ version: string; notes: string | null } | null>(null);
  lastCheck = $state<number | null>(null);
  lastError = $state<string | null>(null);
  /** Download progress, 0–100, while downloading. */
  progress = $state<number | null>(null);
  kind = $state<InstallKind>('unsupported');
  private dismissedVersion = $state<string | null>(null);

  private deps: UpdatesDeps | null = null;
  private handle: UpdateHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** The notice is hidden for this version. */
  get dismissed(): boolean {
    return this.available !== null && this.available.version === this.dismissedVersion;
  }

  /** deb and rpm installs, and the browser UI, cannot replace themselves. */
  get canSelfUpdate(): boolean {
    return this.kind !== 'linux-package' && this.kind !== 'unsupported';
  }

  init = (deps: UpdatesDeps): void => {
    this.deps = deps;
    this.disposed = false;
    this.current = deps.appVersion;
    void this.start();
  };

  private start = async (): Promise<void> => {
    const deps = this.deps!;
    this.kind = await deps.updater.installKind().catch((): InstallKind => 'unsupported');
    if (this.kind === 'unsupported') {
      this.phase = 'unsupported';
      return;
    }
    const stored = await deps.api
      .request('uiState.get', { key: DISMISSED_KEY })
      .then((r) => r.value)
      .catch(() => null);
    if (typeof stored === 'string') this.dismissedVersion = stored;
    this.schedule(FIRST_CHECK_DELAY_MS);
  };

  private schedule = (ms: number): void => {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, ms);
  };

  /** Asks GitHub for a newer release. Only a manual check reports that GitHub was unreachable. */
  check = async (opts: { manual?: boolean } = {}): Promise<void> => {
    const deps = this.deps;
    if (!deps || this.phase === 'unsupported') return;
    if (this.phase === 'downloading' || this.phase === 'installing') return;
    this.phase = 'checking';
    if (opts.manual) this.lastError = null;
    try {
      const found = await deps.updater.check();
      this.lastCheck = (deps.now ?? Date.now)();
      this.handle = found;
      this.available = found ? { version: found.version, notes: found.notes } : null;
      this.phase = found ? 'available' : 'idle';
    } catch {
      this.phase = this.available ? 'available' : 'idle';
      if (opts.manual) this.lastError = UNREACHABLE;
    }
  };

  /** Hides the notice until a newer version appears. */
  dismiss = (): void => {
    const version = this.available?.version;
    if (!version || !this.deps) return;
    this.dismissedVersion = version;
    this.deps.api.request('uiState.set', { key: DISMISSED_KEY, value: version }).catch(() => {});
  };

  /** Download and verify, then stop the local service, install and relaunch. */
  install = async (): Promise<void> => {
    const deps = this.deps;
    const handle = this.handle;
    if (!deps || !handle || !this.canSelfUpdate) return;
    this.lastError = null;
    this.phase = 'downloading';
    this.progress = 0;
    try {
      await handle.download((done, total) => {
        if (total) this.progress = Math.min(100, Math.round((done / total) * 100));
      });
    } catch {
      this.phase = 'available';
      this.progress = null;
      this.lastError = NOT_DOWNLOADED;
      return;
    }
    this.phase = 'ready';
    await deps.stopLocalService();
    this.phase = 'installing';
    await handle.install();
    await deps.updater.relaunch();
  };

  dispose = (): void => {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  };
}

export const updates = new UpdatesState();

/** At most this many chats are named when an update would stop them. */
const NAMED_CHATS = 5;

/**
 * What updating stops on This PC, for its confirmation: up to five chats by
 * title (then "and N more"), then the scheduled messages.
 */
export const updateStops = (titles: readonly string[], scheduled: number): string => {
  const parts: string[] = [];
  if (titles.length > 0) {
    const named = titles.slice(0, NAMED_CHATS).join(', ');
    const more = titles.length - NAMED_CHATS;
    parts.push(more > 0 ? `${named} and ${more} more` : named);
  }
  if (scheduled > 0)
    parts.push(`${scheduled} scheduled ${scheduled === 1 ? 'message' : 'messages'}`);
  return `Updating restarts Threadgarden's service on This PC, which stops: ${parts.join(', and ')}. You can resume them afterwards. Chats on other machines keep running.`;
};
