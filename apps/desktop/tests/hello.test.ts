import { PROTOCOL_VERSION } from '@pahub/protocol';
import { describe, expect, it } from 'vitest';
import { fetchHello } from '../src/lib/service/hello';

type Sent = { id: number; method: string; params: unknown };

/** Minimal stand-in for the browser WebSocket that answers `hello` like the service. */
const fakeSocket = (reply: (req: Sent) => unknown) => {
  const seen: { url?: string; protocols?: string | string[]; sent: Sent[] } = { sent: [] };
  class FakeWs {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(url: string, protocols?: string | string[]) {
      seen.url = url;
      seen.protocols = protocols;
      queueMicrotask(() => this.onopen?.());
    }
    send(data: string) {
      const req = JSON.parse(data) as Sent;
      seen.sent.push(req);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply(req)) }));
    }
    close() {}
  }
  return { seen, Impl: FakeWs as unknown as typeof WebSocket };
};

describe('fetchHello', () => {
  it('authenticates with the token subprotocol and returns the service version', async () => {
    const { seen, Impl } = fakeSocket((req) => ({
      id: req.id,
      result: { serviceVersion: '1.2.3', protocolVersion: PROTOCOL_VERSION },
    }));
    const hello = await fetchHello({ port: 4242, token: 'tok' }, { WebSocketImpl: Impl });
    expect(hello.serviceVersion).toBe('1.2.3');
    expect(seen.url).toBe('ws://127.0.0.1:4242');
    expect(seen.protocols).toEqual(['pahub.tok']);
    expect(seen.sent[0]).toMatchObject({
      method: 'hello',
      params: { protocolVersion: PROTOCOL_VERSION, client: 'pahub-desktop' },
    });
  });

  it('rejects an incompatible service', async () => {
    const { Impl } = fakeSocket((req) => ({
      id: req.id,
      result: { serviceVersion: '9.0.0', protocolVersion: PROTOCOL_VERSION + 1 },
    }));
    await expect(fetchHello({ port: 1, token: 't' }, { WebSocketImpl: Impl })).rejects.toThrow(
      'service-version-mismatch',
    );
  });
});
