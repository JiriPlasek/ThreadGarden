import type { ClientStatus } from '../service/client';
import type { Api } from './api';

type Versions = { serviceVersion: string; appVersion: string };

/** Compares dotted numeric versions (`0.10.0` > `0.9.1`); pre-release suffixes are ignored. */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

export class ConnectionState {
  status = $state<ClientStatus>('connecting');
  serviceVersion = $state<string | null>(null);
  appVersion = $state<string | null>(null);
  indexing = $state<{ done: number; total: number } | null>(null);

  /** Older or newer service still running (spec §4.2): the UI offers "Restart the Threadgarden service to update". */
  restartNeeded = $derived(
    this.serviceVersion !== null &&
      this.appVersion !== null &&
      this.serviceVersion !== this.appVersion,
  );
  /** Not live: the socket is down or the service speaks another protocol. */
  offline = $derived(this.status !== 'open');

  /** The running service is newer than this app (rare: an app downgrade). */
  serviceNewer = $derived(
    this.restartNeeded && compareVersions(this.serviceVersion!, this.appVersion!) > 0,
  );

  init = (api: Api, versions?: Versions): void => {
    this.status = api.status;
    if (versions) this.setVersions(versions);
    api.onStatus((s) => (this.status = s));
    api.on('index.progress', (p) => (this.indexing = p.done >= p.total ? null : p));
  };

  /** Versions reported by the shell for the service the client connects to. */
  setVersions = (versions: Versions): void => {
    this.serviceVersion = versions.serviceVersion;
    this.appVersion = versions.appVersion;
  };

  /**
   * The shell found a service speaking another protocol (`service-version-mismatch`)
   * before the client could connect: the UI shows the blocking restart banner.
   */
  markIncompatible = (): void => {
    this.status = 'incompatible';
  };
}

export const connection = new ConnectionState();
