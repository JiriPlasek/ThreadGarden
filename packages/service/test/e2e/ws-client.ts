import type { EventMsg } from '@threadgarden/protocol';
import { WebSocket } from 'ws';

export type RpcError = { code: string; message: string };

/** A real WebSocket client for the service: requests by id, every pushed event recorded. */
export class TestClient {
  readonly events: EventMsg[] = [];
  private nextId = 1;
  private readonly waiting = new Map<number, (m: { result?: unknown; error?: RpcError }) => void>();
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as {
        id?: number;
        event?: string;
        result?: unknown;
        error?: RpcError;
      };
      if (typeof m.id === 'number') {
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        return;
      }
      this.events.push(m as EventMsg);
      for (const l of this.listeners) l();
    });
  }

  static connect(port: number, token: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, `threadgarden.${token}`);
      ws.once('error', reject);
      ws.once('open', () => resolve(new TestClient(ws)));
    });
  }

  /** Full response (`{result}` or `{error}`). */
  raw(method: string, params: unknown): Promise<{ result?: unknown; error?: RpcError }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** The result; throws the protocol error. */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const r = await this.raw(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result as T;
  }

  /** Resolves with the first recorded event (from now or earlier) matching `pred`. */
  waitFor(pred: (e: EventMsg) => boolean, timeoutMs = 3_000): Promise<EventMsg> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error('waitFor: timed out'));
      }, timeoutMs);
      const check = () => {
        const e = this.events.find(pred);
        if (!e) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(e);
      };
      this.listeners.add(check);
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export const chatStatus = (sessionId: string, status: string) => (e: EventMsg) =>
  e.event === 'chat.status' &&
  (e.data as { sessionId: string; status: string }).sessionId === sessionId &&
  (e.data as { status: string }).status === status;

/** Polls `fn` until it returns a truthy value. */
export const eventually = async <T>(fn: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
