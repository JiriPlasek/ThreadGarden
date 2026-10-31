import { PROTOCOL_VERSION } from '@threadgarden/protocol';

export type Sent = { id: number; method: string; params: unknown };

export class RpcFail extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

type Handler = (params: unknown) => unknown;

/** In-memory service: a fake `WebSocket` class plus scripted method handlers. */
export class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly sent: Sent[] = [];
  readonly protocols: (string | string[] | undefined)[] = [];
  handlers: Record<string, Handler> = {
    hello: () => ({ serviceVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION }),
  };
  /** While true new connections fail instead of opening. */
  refuse = false;
  /** Methods that never get an answer. */
  silent = new Set<string>();

  Impl: typeof WebSocket;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    this.Impl = class extends FakeSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(server, url);
        server.protocols.push(protocols);
      }
    } as unknown as typeof WebSocket;
  }

  get live(): FakeSocket | undefined {
    return this.sockets.filter((s) => s.open).at(-1);
  }

  push = (event: string, data: unknown): void => {
    this.live?.deliver({ event, data });
  };

  /** Drops the connection like a crashed service would (or closes it with `code`). */
  drop = (code = 1006): void => this.live?.serverClose(code);

  /** The URL of the newest connection attempt. */
  get url(): string | undefined {
    return this.sockets.at(-1)?.url;
  }

  calls = (method: string): Sent[] => this.sent.filter((s) => s.method === method);
}

export class FakeSocket {
  open = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(
    private readonly server: FakeServer,
    readonly url: string,
  ) {
    server.sockets.push(this);
    queueMicrotask(() => {
      if (server.refuse) {
        this.onerror?.();
        this.onclose?.({ code: 1006 });
        return;
      }
      this.open = true;
      this.onopen?.();
    });
  }

  send(data: string): void {
    const req = JSON.parse(data) as Sent;
    this.server.sent.push(req);
    if (this.server.silent.has(req.method)) return;
    queueMicrotask(() => {
      if (!this.open) return;
      const fail = (err: unknown): void => {
        if (err instanceof RpcFail) {
          this.deliver({ id: req.id, error: { code: err.code, message: err.message } });
        } else throw err;
      };
      try {
        const h = this.server.handlers[req.method];
        if (!h) throw new RpcFail('METHOD_NOT_FOUND');
        const result = h(req.params);
        // A handler may answer later (a Promise), e.g. to hold a request in flight.
        if (result instanceof Promise) {
          result.then((r) => this.deliver({ id: req.id, result: r }), fail);
        } else {
          this.deliver({ id: req.id, result });
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  deliver(msg: unknown): void {
    if (this.open) this.onmessage?.({ data: JSON.stringify(msg) });
  }

  close(): void {
    this.serverClose(1000);
  }

  serverClose(code = 1006): void {
    if (!this.open) return;
    this.open = false;
    this.onclose?.({ code });
  }
}

/** A `WebSocket` class that hands each connection to the server `pick` chooses by URL. */
export const routedImpl = (pick: (url: string) => FakeServer): typeof WebSocket =>
  class {
    constructor(url: string, protocols?: string | string[]) {
      return new (pick(url).Impl as unknown as new (u: string, p?: string | string[]) => object)(
        url,
        protocols,
      );
    }
  } as unknown as typeof WebSocket;
