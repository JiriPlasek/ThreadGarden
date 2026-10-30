import type { ClientStatus } from '../service/client';
import type { Api } from './api';

export class ConnectionState {
  status = $state<ClientStatus>('connecting');
  serviceVersion = $state<string | null>(null);
  appVersion = $state<string | null>(null);
  indexing = $state<{ done: number; total: number } | null>(null);

  /** Older or newer service still running (spec §4.2): the UI offers "Restart the pahub service to update". */
  restartNeeded = $derived(
    this.serviceVersion !== null &&
      this.appVersion !== null &&
      this.serviceVersion !== this.appVersion,
  );
  /** Not live: the socket is down or the service speaks another protocol. */
  offline = $derived(this.status !== 'open');

  init = (api: Api, versions?: { serviceVersion: string; appVersion: string }): void => {
    this.status = api.status;
    if (versions) {
      this.serviceVersion = versions.serviceVersion;
      this.appVersion = versions.appVersion;
    }
    api.onStatus((s) => (this.status = s));
    api.on('index.progress', (p) => (this.indexing = p.done >= p.total ? null : p));
  };
}

export const connection = new ConnectionState();
