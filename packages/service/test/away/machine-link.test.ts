import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connectToMachine, DeviceRefused } from '../../src/away/deliverer.js';
import { LinkError, RemoteError } from '../../src/machine/link.js';
import type { StoredMachine } from '../../src/machine/paired-machines.js';
import { startFakeMachine, type FakeMachine } from '../machine/fake-machine.js';

const TOKEN = 'b'.repeat(64);

describe("the deliverer's link to a machine", () => {
  let dir: string;
  let fake: FakeMachine;
  let impostor: FakeMachine;
  /** The real listener's way with a bad or revoked token: upgraded, then closed 4401. */
  let closes: FakeMachine;
  /** And the relay's other sign of it: the upgrade answered 403. */
  let forbids: Server;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-away-link-'));
    const answer = (ws: import('ws').WebSocket) =>
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d)) as { id: number; method: string };
        ws.send(
          JSON.stringify(
            msg.method === 'chat.send'
              ? { id: msg.id, result: { queued: false } }
              : { id: msg.id, error: { code: 'MOVED', message: 'This chat is on Laptop now' } },
          ),
        );
      });
    fake = await startFakeMachine(dir, answer);
    impostor = await startFakeMachine(dir, answer);
    closes = await startFakeMachine(dir, (ws) => ws.close(4401, 'unauthorized'), {
      tls: fake.tls,
    });
    forbids = createServer({ key: fake.tls.keyPem, cert: fake.tls.certPem });
    forbids.on('upgrade', (_req, socket) =>
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
    );
    await new Promise<void>((resolve) => forbids.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await fake.close();
    await impostor.close();
    await closes.close();
    await new Promise((resolve) => forbids.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const machines = (port: number) => ({
    get: (id: string): StoredMachine | null =>
      id === 'm-1'
        ? {
            id,
            name: 'Fake',
            address: '127.0.0.1',
            port,
            fingerprint: fake.tls.fingerprint256,
            certPem: fake.tls.certPem,
            deviceId: 'd',
            addedAt: 0,
            unlocked: true,
          }
        : null,
    token: (id: string) => (id === 'm-1' ? TOKEN : null),
  });

  it('opens a pinned link with the token, carries answers and refusals, and closes', async () => {
    const link = await connectToMachine(machines(fake.port), { linkTimeoutMs: 2_000 })('m-1');
    expect(link).not.toBeNull();
    expect(fake.upgradeRequests().at(-1)?.['sec-websocket-protocol']).toBe(
      `threadgarden-device.${TOKEN}`,
    );
    await expect(link!.request('chat.send', { sessionId: 's', text: 'hi' })).resolves.toEqual({
      queued: false,
    });
    const refused = await link!.request('chat.create', {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RemoteError);
    expect(refused).toMatchObject({ code: 'MOVED', message: 'This chat is on Laptop now' });
    link!.close();
    const lost = await link!.request('chat.send', {}).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(LinkError);
  });

  it('is null for a machine with another certificate, with nothing sent', async () => {
    const link = await connectToMachine(machines(impostor.port), { linkTimeoutMs: 2_000 })('m-1');
    expect(link).toBeNull();
    expect(impostor.upgradeRequests()).toEqual([]);
  });

  it('says so, by name, when the machine turns this device away', async () => {
    const message = 'Fake refused this device; pair it again';
    const link = await connectToMachine(machines(closes.port), { linkTimeoutMs: 2_000 })('m-1');
    const refused = await link!.request('chat.send', {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DeviceRefused);
    expect(refused).toMatchObject({ message });
    const port = (forbids.address() as AddressInfo).port;
    const atTheDoor = await connectToMachine(machines(port), { linkTimeoutMs: 2_000 })('m-1').catch(
      (e: unknown) => e,
    );
    expect(atTheDoor).toBeInstanceOf(DeviceRefused);
    expect(atTheDoor).toMatchObject({ message });
  });

  it('is null without a token, or for a machine that does not answer', async () => {
    const noToken = { ...machines(fake.port), token: () => null };
    expect(await connectToMachine(noToken)('m-1')).toBeNull();
    expect(await connectToMachine(machines(1), { linkTimeoutMs: 500 })('m-1')).toBeNull();
    expect(await connectToMachine(machines(fake.port))('nobody')).toBeNull();
  });
});
