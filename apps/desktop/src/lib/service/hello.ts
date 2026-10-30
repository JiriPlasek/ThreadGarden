/**
 * One-shot `hello` to the service: proves the connection works and reports
 * the service version. A stand-in until the full WebSocket client exists.
 */
import { PROTOCOL_VERSION } from '@pahub/protocol';
import type { ServiceConnection } from '../native';

export type HelloResult = { serviceVersion: string; protocolVersion: number };

export const fetchHello = (
  conn: Pick<ServiceConnection, 'port' | 'token'>,
  opts: { WebSocketImpl?: typeof WebSocket; timeoutMs?: number } = {},
): Promise<HelloResult> =>
  new Promise((resolve, reject) => {
    const Impl = opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(`ws://127.0.0.1:${conn.port}`, [`pahub.${conn.token}`]);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('service-unreachable'))),
      opts.timeoutMs ?? 5000,
    );
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'hello',
          params: { protocolVersion: PROTOCOL_VERSION, client: 'pahub-desktop' },
        }),
      );
    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number;
        result?: HelloResult;
        error?: { message: string };
      };
      if (msg.id !== 1) return;
      if (msg.error) return finish(() => reject(new Error(msg.error?.message)));
      const result = msg.result;
      if (!result || result.protocolVersion !== PROTOCOL_VERSION) {
        return finish(() => reject(new Error('service-version-mismatch')));
      }
      finish(() => resolve(result));
    };
    ws.onerror = () => finish(() => reject(new Error('service-unreachable')));
    ws.onclose = () => finish(() => reject(new Error('service-unreachable')));
  });
