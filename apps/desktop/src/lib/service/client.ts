/**
 * WebSocket client for the local Threadgarden service: request/response by id,
 * typed events, reconnect with backoff and a hook for resync after reconnect
 * (spec §4.5). Protocol version mismatch makes the client `incompatible`.
 */
import {
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  type EventData,
  type EventName,
  type MethodName,
  type Params,
  type Result,
} from '@pahub/protocol';

export type ClientStatus = 'connecting' | 'open' | 'reconnecting' | 'incompatible';

/**
 * Rejection of a request; `code` is a protocol error code or DISCONNECTED /
 * TIMEOUT / INCOMPATIBLE / TOO_LARGE.
 */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export type ClientOptions = {
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: RequestError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ServiceClient {
  status: ClientStatus = 'connecting';

  private readonly Impl: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private ws: WebSocket | null = null;
  private url = '';
  private token = '';
  private nextId = 1;
  private attempt = 0;
  private closed = false;
  private hasBeenOpen = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(data: never) => void>>();
  private readonly statusListeners = new Set<(s: ClientStatus) => void>();
  private readonly openListeners = new Set<() => void | Promise<void>>();
  private readonly reconnectListeners = new Set<() => void | Promise<void>>();
  private firstConnect: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: ClientOptions = {}) {
    this.Impl = opts.WebSocketImpl ?? WebSocket;
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.minMs = opts.backoffMinMs ?? 250;
    this.maxMs = opts.backoffMaxMs ?? 5_000;
  }

  /**
   * Resolves after the next successful `hello`; rejects with `INCOMPATIBLE` on a
   * protocol mismatch. Keeps retrying (status `connecting`) while the service is unreachable.
   * Called again (e.g. after "Restart service"), it drops the current socket and
   * switches to the given service; once connected, `onOpen` and (after an earlier
   * connection) `onReconnect` listeners run so the state resyncs.
   */
  connect = (url: string, token: string): Promise<void> => {
    this.url = url;
    this.token = token;
    this.closed = false;
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    const old = this.ws;
    if (old) {
      this.ws = null;
      old.close();
      this.rejectAll('DISCONNECTED', 'Switching to another service');
    }
    if (this.status !== 'connecting') {
      this.setStatus(this.hasBeenOpen ? 'reconnecting' : 'connecting');
    }
    const earlier = this.firstConnect;
    return new Promise<void>((resolve, reject) => {
      this.firstConnect = {
        resolve: () => {
          earlier?.resolve();
          resolve();
        },
        reject: (e) => {
          earlier?.reject(e);
          reject(e);
        },
      };
      this.open();
    });
  };

  close = (): void => {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.rejectAll('DISCONNECTED', 'Client closed');
  };

  /** Rejects with `DISCONNECTED` while the socket is down (callers retry) and `TIMEOUT` after the request timeout. */
  request = <M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> => {
    if (this.status !== 'open' || !this.ws) {
      return Promise.reject(new RequestError('DISCONNECTED', 'Not connected to the service'));
    }
    return this.send(method, params) as Promise<Result<M>>;
  };

  on = <E extends EventName>(event: E, cb: (data: EventData<E>) => void): (() => void) => {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const fn = cb as (data: never) => void;
    set.add(fn);
    return () => set.delete(fn);
  };

  onStatus = (cb: (s: ClientStatus) => void): (() => void) => {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  };

  /** Called after every reconnect (not the first connect), once `hello` succeeded and requests work again. */
  onReconnect = (cb: () => void | Promise<void>): (() => void) => {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  };

  /** Called after every successful `hello`, including the first connect. */
  onOpen = (cb: () => void | Promise<void>): (() => void) => {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  };

  private setStatus = (s: ClientStatus): void => {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  };

  private send = (method: string, params: unknown): Promise<unknown> => {
    const ws = this.ws;
    if (!ws) return Promise.reject(new RequestError('DISCONNECTED', 'Not connected'));
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    // The service closes the connection on an oversized frame, which would lose
    // the message silently: refuse it here instead. (UTF-8 is at most 3 bytes
    // per UTF-16 unit, so only long frames need measuring.)
    const bytes =
      frame.length * 3 > MAX_REQUEST_BYTES ? new TextEncoder().encode(frame).length : frame.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      return Promise.reject(
        new RequestError(
          'TOO_LARGE',
          `This message is too large to send (${mb(bytes)} MB; at most ${mb(MAX_REQUEST_BYTES)} MB). Remove some images and try again.`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('TIMEOUT', `${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RequestError('DISCONNECTED', 'Send failed'));
      }
    });
  };

  private rejectAll = (code: string, message: string): void => {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RequestError(code, message));
      this.pending.delete(id);
    }
  };

  private open = (): void => {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new this.Impl(this.url, [`pahub.${this.token}`]);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send('hello', { protocolVersion: PROTOCOL_VERSION, client: 'pahub-desktop' }).then(
        (r) => {
          if (this.ws !== ws) return;
          if ((r as { protocolVersion?: number }).protocolVersion !== PROTOCOL_VERSION) {
            return this.fail(ws);
          }
          this.attempt = 0;
          const reconnect = this.hasBeenOpen;
          this.hasBeenOpen = true;
          this.setStatus('open');
          this.firstConnect?.resolve();
          this.firstConnect = null;
          for (const cb of this.openListeners) void Promise.resolve(cb()).catch(() => {});
          if (reconnect) {
            for (const cb of this.reconnectListeners) void Promise.resolve(cb()).catch(() => {});
          }
        },
        (e: unknown) => {
          // A service that refuses our protocol version answers hello with an error.
          if (this.ws !== ws || !(e instanceof RequestError)) return;
          if (e.code === 'DISCONNECTED') return; // onclose schedules the retry
          if (e.code === 'TIMEOUT') return ws.close(); // unresponsive: drop it and retry with backoff
          this.fail(ws);
        },
      );
    };
    ws.onmessage = (e: MessageEvent) => this.onMessage(String(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.rejectAll('DISCONNECTED', 'Connection to the service dropped');
      if (this.closed) return;
      this.setStatus(this.hasBeenOpen ? 'reconnecting' : 'connecting');
      this.scheduleRetry();
    };
    ws.onerror = () => {};
  };

  private fail = (ws: WebSocket): void => {
    this.closed = true;
    this.ws = null;
    this.setStatus('incompatible');
    ws.close();
    this.rejectAll('DISCONNECTED', 'Incompatible service');
    this.firstConnect?.reject(new RequestError('INCOMPATIBLE', 'Incompatible protocol version'));
    this.firstConnect = null;
  };

  private scheduleRetry = (): void => {
    const delay = Math.min(this.maxMs, this.minMs * 2 ** this.attempt);
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(this.open, delay);
  };

  private onMessage = (raw: string): void => {
    let msg: {
      id?: number;
      event?: string;
      data?: unknown;
      result?: unknown;
      error?: { code: string; message: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RequestError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (typeof msg.event === 'string') {
      for (const cb of this.listeners.get(msg.event) ?? []) cb(msg.data as never);
    }
  };
}
