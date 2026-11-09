import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle } from '../src/main.js';
import { generateCorpus } from '../src/testing/corpus.js';
import { TestClient } from './e2e/ws-client.js';

/**
 * The phone's core (Rust) pairs with a real headless service, so the two
 * implementations of pairing can't drift. The core side is the crate's
 * `pair_check` example; CI builds it in the rust job (`cargo test` builds
 * examples) and runs this file there. Where it isn't built, this is skipped.
 */
const bin = fileURLToPath(
  new URL(
    `../../../apps/desktop/src-tauri/core/target/debug/examples/pair_check${
      process.platform === 'win32' ? '.exe' : ''
    }`,
    import.meta.url,
  ),
);
const built = existsSync(bin);

type Answer = { result?: Record<string, unknown>; error?: { code: string; message: string } };
type Steps = { pair: Answer; list: Answer; remove: Answer };

const quietLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
});

let dir: string;
let svc: ServiceHandle;

beforeAll(async () => {
  if (!built) return;
  dir = await mkdtemp(join(tmpdir(), 'tg-core-pairing-'));
  // A service of its own in a temp dir: never the one running on this machine.
  svc = await startService({
    dataDir: join(dir, 'machine'),
    claudeConfigDir: join(dir, 'claude-missing'),
    adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
    installSignalHandlers: false,
    headless: true,
    host: null,
    remote: { addresses: ['127.0.0.1'], port: 0 },
    logger: quietLogger(),
  });
});
afterAll(async () => {
  if (!built) return;
  await svc.close();
  await rm(dir, { recursive: true, force: true });
});

const local = async <T>(method: string, params: unknown): Promise<T> => {
  const client = await TestClient.connect(svc.port, svc.token);
  try {
    return await client.call<T>(method, params);
  } finally {
    await client.close();
  }
};

/** Runs the core against the service with `code`: its answers by step. */
const runCore = async (code: string): Promise<Steps> => {
  const { stdout } = await promisify(execFile)(bin, ['127.0.0.1', String(svc.remote!.port), code], {
    timeout: 60_000,
  });
  const steps = {} as Steps;
  for (const line of stdout.trim().split('\n')) {
    const { step, answer } = JSON.parse(line) as { step: keyof Steps; answer: Answer };
    steps[step] = answer;
  }
  return steps;
};

/** The service's certificate fingerprint, as a device sees it. */
const fingerprint = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port: svc.remote!.port,
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.destroy();
    });
    socket.once('error', reject);
  });

describe.skipIf(!built)('the phone core and a real service', () => {
  it('pair, list the machine and revoke the phone on removal', async () => {
    const { code } = await local<{ code: string }>('pairing.create', {});
    const machine = await local<{ id: string; name: string }>('machine.get', {});
    const steps = await runCore(code);

    expect(steps.pair.error).toBeUndefined();
    const paired = steps.pair.result as { machine: Record<string, unknown>; token: string };
    expect(paired.machine).toMatchObject({
      id: machine.id,
      name: machine.name,
      address: '127.0.0.1',
      port: svc.remote!.port,
      fingerprint: await fingerprint(),
      unlocked: true,
    });
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);
    expect(steps.list.result).toEqual([paired.machine]);
    // Removed with revoke: the service forgot the device.
    expect(steps.remove.result).toEqual({ revoked: true });
    expect(await local('devices.list', {})).toEqual([]);
  }, 90_000);

  it('a wrong code fails the proof, and the code is never spent', async () => {
    const { code } = await local<{ code: string }>('pairing.create', {});
    const wrong = code.startsWith('A') ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
    const failed = await runCore(wrong);
    expect(failed.pair.error?.code).toBe('PAIRING_PROOF_FAILED');
    expect(await local('devices.list', {})).toEqual([]);
    // No claim was made, so the live code still pairs.
    const steps = await runCore(code);
    expect(steps.pair.error).toBeUndefined();
    expect(steps.remove.result).toEqual({ revoked: true });
  }, 90_000);

  it('no code out: the pairing socket is refused, and the core says the code is not valid', async () => {
    const steps = await runCore('ABCD-EFGH-JKMN');
    expect(steps.pair.error).toEqual({
      code: 'PAIRING_INVALID',
      message: 'The pairing code is not valid',
    });
  }, 90_000);
});
