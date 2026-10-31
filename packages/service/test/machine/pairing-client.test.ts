import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineInfo } from '@threadgarden/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startService, type ServiceHandle } from '../../src/main.js';
import { normalisePairingCode, pairingProof } from '../../src/machine/devices.js';
import { pairWithMachine } from '../../src/machine/pairing-client.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { TestClient } from '../e2e/ws-client.js';
import { answerRequests, startFakeMachine, type FakeMachine } from './fake-machine.js';

let dir: string;
let remote: ServiceHandle;
const cleanup: (() => Promise<unknown>)[] = [];

const quietLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-pairing-client-'));
  remote = await startService({
    dataDir: join(dir, 'remote'),
    claudeConfigDir: join(dir, 'claude-missing'),
    adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
    installSignalHandlers: false,
    headless: true,
    remote: { addresses: ['127.0.0.1'], port: 0 },
    logger: quietLogger(),
  });
});
afterAll(async () => {
  await remote.close();
  await rm(dir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const localCall = async <T = unknown>(svc: ServiceHandle, method: string, params: unknown) => {
  const client = await TestClient.connect(svc.port, svc.token);
  try {
    return await client.call<T>(method, params);
  } finally {
    await client.close();
  }
};
const newCode = async (): Promise<string> =>
  (await localCall<{ code: string }>(remote, 'pairing.create', {})).code;
const fake = async (onSocket?: Parameters<typeof startFakeMachine>[1]): Promise<FakeMachine> => {
  const f = await startFakeMachine(dir, onSocket);
  cleanup.push(() => f.close());
  return f;
};
const machineInfo = (id: string): MachineInfo => ({
  id,
  name: 'Fake',
  platform: 'linux',
  headless: true,
  home: '',
  capabilities: ['remote'],
});
/** A pairing peer that knows `code` and proves it for its own certificate. */
const honestPeer = (code: string, claim: () => object) => {
  const holder: { fake?: FakeMachine } = {};
  return {
    holder,
    onSocket: (ws: WebSocket) =>
      answerRequests(ws, (method, params) => {
        if (method === 'pair.proof') {
          const { nonce } = params as { nonce: string };
          const fp = holder.fake!.tls.fingerprint256;
          return {
            result: {
              proof: pairingProof(normalisePairingCode(code), fp, nonce),
              machine: machineInfo('fake-1'),
            },
          };
        }
        if (method === 'pair.claim') return claim();
        return { error: { code: 'METHOD_NOT_FOUND', message: method } };
      }),
  };
};

describe('pairWithMachine', () => {
  it('pairs with a headless machine and pins its certificate', async () => {
    const code = await newCode();
    const paired = await pairWithMachine({
      address: '127.0.0.1',
      port: remote.remote!.port,
      code: code.toLowerCase(),
      deviceName: 'Gaming PC',
    });
    const certPem = await readFile(join(dir, 'remote', 'tls', 'cert.pem'), 'utf8');
    expect(paired.certPem.trim()).toBe(certPem.trim());
    expect(paired.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);
    expect(paired.machine).toMatchObject({ headless: true, name: expect.any(String) });
    expect(paired.deviceId).toEqual(expect.any(String));
    const devices = await localCall<{ id: string; name: string }[]>(remote, 'devices.list', {});
    expect(devices).toContainEqual(
      expect.objectContaining({ id: paired.deviceId, name: 'Gaming PC' }),
    );
    // The code is spent.
    await expect(
      pairWithMachine({ address: '127.0.0.1', port: remote.remote!.port, code, deviceName: 'x' }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
  });

  it('never sends the code when the proof does not match the certificate', async () => {
    const code = await newCode();
    // A man in the middle with its own certificate relays every frame to the
    // real machine, so the proof it returns is bound to the real certificate.
    const mitm = await fake((ws) => {
      const upstream = new WebSocket(
        `wss://127.0.0.1:${remote.remote!.port}`,
        ['threadgarden-pair'],
        {
          rejectUnauthorized: false,
        },
      );
      upstream.on('error', () => {});
      const pending: string[] = [];
      upstream.on('open', () => pending.splice(0).forEach((f) => upstream.send(f)));
      ws.on('message', (d) => {
        if (upstream.readyState === upstream.OPEN) upstream.send(String(d));
        else pending.push(String(d));
      });
      upstream.on('message', (d) => ws.send(String(d)));
      ws.on('close', () => upstream.close());
    });
    await expect(
      pairWithMachine({ address: '127.0.0.1', port: mitm.port, code, deviceName: 'x' }),
    ).rejects.toMatchObject({ code: 'PAIRING_PROOF_FAILED' });
    expect(mitm.calls('pair.proof')).toHaveLength(1);
    expect(mitm.calls('pair.claim')).toHaveLength(0);
    expect(JSON.stringify(mitm.received())).not.toContain(code.replaceAll('-', '').slice(0, 4));
    // The pairing socket is not held open.
    await expect.poll(() => mitm.closed()).toBe(1);
  });

  it('fails the proof when the machine has no live code', async () => {
    const f = await fake((ws) =>
      answerRequests(ws, (method) =>
        method === 'pair.proof'
          ? { result: { proof: null, machine: machineInfo('fake-1') } }
          : { error: { code: 'X', message: 'x' } },
      ),
    );
    await expect(
      pairWithMachine({
        address: '127.0.0.1',
        port: f.port,
        code: 'ABCD-EFGH-JKMN',
        deviceName: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_PROOF_FAILED' });
    expect(f.calls('pair.claim')).toHaveLength(0);
  });

  it('fails the proof when the code typed is not the one shown', async () => {
    const code = await newCode();
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`;
    await expect(
      pairWithMachine({
        address: '127.0.0.1',
        port: remote.remote!.port,
        code: wrong,
        deviceName: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_PROOF_FAILED' });
    // Nothing was claimed: the right code still works.
    await expect(
      pairWithMachine({ address: '127.0.0.1', port: remote.remote!.port, code, deviceName: 'x' }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('claims after a valid proof and closes the pairing socket at once', async () => {
    const code = 'ABCD-EFGH-JKMN';
    const peer = honestPeer(code, () => ({
      result: { deviceId: 'd-1', token: 'f'.repeat(64), machine: machineInfo('fake-1') },
    }));
    const f = await fake(peer.onSocket);
    peer.holder.fake = f;
    const paired = await pairWithMachine({
      address: '127.0.0.1',
      port: f.port,
      code: 'abcd efgh jkmn',
      deviceName: 'Gaming PC',
    });
    expect(paired).toEqual({
      machine: machineInfo('fake-1'),
      deviceId: 'd-1',
      token: 'f'.repeat(64),
      certPem: expect.stringContaining('BEGIN CERTIFICATE'),
      fingerprint: f.tls.fingerprint256,
    });
    expect(f.calls('pair.claim')).toEqual([{ code: 'ABCDEFGHJKMN', deviceName: 'Gaming PC' }]);
    await expect.poll(() => f.closed(), { timeout: 2_000 }).toBe(1);
  });

  it('passes on the machine refusing the claim, and closes the socket', async () => {
    const code = 'ABCD-EFGH-JKMN';
    const peer = honestPeer(code, () => ({
      error: { code: 'PAIRING_EXPIRED', message: 'The pairing code has expired' },
    }));
    const f = await fake(peer.onSocket);
    peer.holder.fake = f;
    await expect(
      pairWithMachine({ address: '127.0.0.1', port: f.port, code, deviceName: 'x' }),
    ).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });
    await expect.poll(() => f.closed(), { timeout: 2_000 }).toBe(1);
  });

  it('stops before the claim when the machine is not acceptable', async () => {
    const code = 'ABCD-EFGH-JKMN';
    const peer = honestPeer(code, () => ({ result: {} }));
    const f = await fake(peer.onSocket);
    peer.holder.fake = f;
    const seen: MachineInfo[] = [];
    await expect(
      pairWithMachine({
        address: '127.0.0.1',
        port: f.port,
        code,
        deviceName: 'x',
        accept: (m) => {
          seen.push(m);
          throw Object.assign(new Error('Already paired'), { code: 'PAIRING_DUPLICATE' });
        },
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_DUPLICATE' });
    expect(seen).toEqual([machineInfo('fake-1')]);
    expect(f.calls('pair.claim')).toHaveLength(0);
  });

  it('refuses a malformed code without connecting', async () => {
    const f = await fake();
    for (const code of ['', 'ABCD-EFGH', 'ABCD-EFGH-JKM0', 'ABCD-EFGH-JKMN-PQRS']) {
      await expect(
        pairWithMachine({ address: '127.0.0.1', port: f.port, code, deviceName: 'x' }),
      ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    }
    expect(f.handshakes()).toBe(0);
  });

  it('says invalid when the machine has no pairing code out', async () => {
    // A machine without a live code refuses pairing sockets (HTTP 503).
    const other = await startService({
      dataDir: join(dir, 'idle-remote'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      headless: true,
      remote: { addresses: ['127.0.0.1'], port: 0 },
      logger: quietLogger(),
    });
    cleanup.push(() => other.close());
    await expect(
      pairWithMachine({
        address: '127.0.0.1',
        port: other.remote!.port,
        code: 'ABCD-EFGH-JKMN',
        deviceName: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
  });

  it('says unreachable when nothing listens or nothing answers', async () => {
    const closed = createServer();
    const port = await new Promise<number>((resolve) =>
      closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port)),
    );
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(
      pairWithMachine({ address: '127.0.0.1', port, code: 'ABCD-EFGH-JKMN', deviceName: 'x' }),
    ).rejects.toMatchObject({ code: 'PAIRING_UNREACHABLE' });

    // A peer that accepts the connection and never says anything.
    const held = new Set<Socket>();
    let released = 0;
    const silent: Server = createServer((s) => {
      held.add(s);
      s.resume();
      s.on('close', () => released++);
    });
    const silentPort = await new Promise<number>((resolve) =>
      silent.listen(0, '127.0.0.1', () => resolve((silent.address() as AddressInfo).port)),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of held) s.destroy();
          silent.close(() => resolve());
        }),
    );
    const started = Date.now();
    await expect(
      pairWithMachine({
        address: '127.0.0.1',
        port: silentPort,
        code: 'ABCD-EFGH-JKMN',
        deviceName: 'x',
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_UNREACHABLE' });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The connection stuck in its TLS handshake is let go.
    await expect.poll(() => released, { timeout: 2_000 }).toBe(1);
  });
});
