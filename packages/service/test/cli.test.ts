import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@threadgarden/protocol';
import { NOT_RUNNING, parseArgs, runCli, type Command } from '../src/cli.js';
import { writeDiscovery } from '../src/discovery.js';
import { startService, type ServiceHandle } from '../src/main.js';
import { generateCorpus } from '../src/testing/corpus.js';

describe('parseArgs', () => {
  it('runs the service without arguments, as the desktop shell does', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve', headless: false });
    expect(parseArgs(['serve'])).toEqual({ kind: 'serve', headless: false });
  });

  it('parses serve options', () => {
    expect(parseArgs(['serve', '--headless'])).toEqual({ kind: 'serve', headless: true });
    expect(parseArgs(['serve', '--headless', '--port', '47390'])).toEqual({
      kind: 'serve',
      headless: true,
      port: 47390,
    });
    expect(parseArgs(['serve', '--port', '47390', '--headless'])).toEqual({
      kind: 'serve',
      headless: true,
      port: 47390,
    });
    const usage = {
      kind: 'error',
      message: 'Usage: threadgarden serve [--headless [--port <port>]]',
    };
    for (const bad of [
      ['serve', '--port', '47390'], // the port is the device listener's: headless only
      ['serve', '--headless', '--port'],
      ['serve', '--headless', '--port', 'x'],
      ['serve', '--headless', '--port', '0'],
      ['serve', '--headless', '--port', '65536'],
      ['serve', '--headless', '--port', '47.5'],
      ['serve', '--headless', '--verbose'],
    ]) {
      expect(parseArgs(bad), bad.join(' ')).toEqual(usage);
    }
  });

  it('parses the client commands', () => {
    expect(parseArgs(['pair'])).toEqual({ kind: 'pair' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['devices'])).toEqual({ kind: 'devices' });
    expect(parseArgs(['revoke', 'd-1'])).toEqual({ kind: 'revoke', deviceId: 'd-1' });
    expect(parseArgs(['rename', 'Ubuntu', 'PC'])).toEqual({ kind: 'rename', name: 'Ubuntu PC' });
    for (const help of [['help'], ['--help'], ['-h']]) {
      expect(parseArgs(help)).toEqual({ kind: 'help' });
    }
  });

  it('explains wrong usage', () => {
    expect(parseArgs(['revoke'])).toEqual({
      kind: 'error',
      message: 'Usage: threadgarden revoke <device-id>',
    });
    expect(parseArgs(['revoke', 'a', 'b'])).toEqual({
      kind: 'error',
      message: 'Usage: threadgarden revoke <device-id>',
    });
    expect(parseArgs(['rename'])).toEqual({
      kind: 'error',
      message: 'Usage: threadgarden rename <name>',
    });
    expect(parseArgs(['rename', ' '])).toEqual({
      kind: 'error',
      message: 'Usage: threadgarden rename <name>',
    });
    expect(parseArgs(['rename', 'x'.repeat(41)])).toEqual({
      kind: 'error',
      message: 'A machine name is at most 40 characters long',
    });
    expect(parseArgs(['pair', 'now'])).toEqual({
      kind: 'error',
      message: 'Usage: threadgarden pair',
    });
    expect(parseArgs(['frobnicate'])).toEqual({
      kind: 'error',
      message: 'Unknown command "frobnicate". Run "threadgarden help" for the list of commands.',
    });
  });
});

describe('runCli', () => {
  let dir: string;
  let svc: ServiceHandle;
  let lines: string[];
  const out = (s: string) => void lines.push(s);
  const run = (cmd: Command, dataDir = join(dir, 'data')) => {
    lines = [];
    return runCli(cmd, { dataDir, out });
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-cli-'));
    svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      headless: true,
      remote: { addresses: ['127.0.0.1'], port: 0 },
    });
  });
  afterAll(async () => {
    await svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('shows a pairing code, the address and the name', async () => {
    expect(await run({ kind: 'pair' })).toBe(0);
    expect(lines.join('\n')).toMatch(
      /Pairing code: [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4} \(valid for 5 minutes\)/,
    );
    const name = (await svc.router.dispatch(
      { id: 1, method: 'machine.get', params: {} },
      { clientId: 't', origin: 'local' },
    )) as { result: { name: string } };
    expect(lines.slice(1)).toEqual([
      `Address: 127.0.0.1:${svc.remote!.port}`,
      `Name: ${name.result.name}`,
    ]);
  });

  it('shows the status', async () => {
    expect(await run({ kind: 'status' })).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`Threadgarden ${(await import('../package.json')).default.version}`);
    expect(text).toContain(`protocol ${PROTOCOL_VERSION}`);
    expect(text).toContain('headless');
    expect(text).toContain(`Listening for devices on 127.0.0.1:${svc.remote!.port}`);
    expect(text).toMatch(/Paired devices: \d+/);
  });

  it('lists, renames and revokes', async () => {
    expect(await run({ kind: 'devices' })).toBe(0);
    expect(lines).toEqual(['No paired devices.']);

    // Pair one through the service's own handlers.
    const code = (
      (await svc.router.dispatch(
        { id: 1, method: 'pairing.create', params: {} },
        { clientId: 't', origin: 'local' },
      )) as { result: { code: string } }
    ).result.code;
    const claimed = (await svc.router.dispatch(
      { id: 2, method: 'pair.claim', params: { code, deviceName: 'Gaming PC' } },
      { clientId: 'p', origin: 'remote' },
    )) as { result: { deviceId: string } };
    const id = claimed.result.deviceId;

    expect(await run({ kind: 'devices' })).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).toContain('Gaming PC');
    expect(lines[0]).toContain('never seen');

    expect(await run({ kind: 'rename', name: 'Ubuntu PC' })).toBe(0);
    expect(lines).toEqual(['This machine is now called "Ubuntu PC".']);
    expect(await run({ kind: 'pair' })).toBe(0);
    expect(lines).toContain('Name: Ubuntu PC');

    expect(await run({ kind: 'revoke', deviceId: id })).toBe(0);
    expect(lines).toEqual([`Revoked ${id} (Gaming PC).`]);
    expect(await run({ kind: 'revoke', deviceId: id })).toBe(1);
    expect(lines).toEqual([`No paired device has the id ${id}.`]);
    expect(await run({ kind: 'devices' })).toBe(0);
    expect(lines).toEqual(['No paired devices.']);
  });

  it('says how to start the service when it is not running', async () => {
    const empty = await mkdtemp(join(dir, 'empty-'));
    for (const cmd of [
      { kind: 'pair' },
      { kind: 'status' },
      { kind: 'devices' },
      { kind: 'revoke', deviceId: 'x' },
      { kind: 'rename', name: 'x' },
    ] as const) {
      expect(await run(cmd, empty)).toBe(1);
      expect(lines).toEqual([NOT_RUNNING]);
    }
    expect(NOT_RUNNING).toBe(
      'Threadgarden is not running. Start it with: systemctl --user start threadgarden',
    );
  });

  it('treats a stale discovery file as not running', async () => {
    const stale = await mkdtemp(join(dir, 'stale-'));
    // A port nothing listens on any more.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const addr = probe.address() as { port: number };
        probe.close(() => resolve(addr.port));
      });
    });
    await writeDiscovery(stale, {
      pid: 1,
      port,
      token: 'gone',
      version: '0.0.0',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: 0,
    });
    expect(await run({ kind: 'status' }, stale)).toBe(1);
    expect(lines).toEqual([NOT_RUNNING]);
  });

  it('treats a service that refuses the token as not running', async () => {
    const wrong = await mkdtemp(join(dir, 'wrong-'));
    await writeDiscovery(wrong, {
      pid: process.pid,
      port: svc.port,
      token: 'not-the-token',
      version: '0.0.0',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: 0,
    });
    expect(await run({ kind: 'devices' }, wrong)).toBe(1);
    expect(lines).toEqual([NOT_RUNNING]);
  });

  it('refuses to pair when the service does not listen for devices', async () => {
    const local = join(dir, 'local');
    const plain = await startService({ dataDir: local, installSignalHandlers: false });
    try {
      expect(await run({ kind: 'pair' }, local)).toBe(1);
      expect(lines.join('\n')).toMatch(/not listening for devices/);
      expect(lines.join('\n')).not.toMatch(/Pairing code/);
    } finally {
      await plain.close();
    }
  });

  it('prints help and usage errors without a service', async () => {
    expect(await run({ kind: 'help' }, join(dir, 'nowhere'))).toBe(0);
    expect(lines.join('\n')).toContain('Usage: threadgarden <command>');
    expect(lines.join('\n')).toContain('revoke <device-id>');
    expect(
      await run({ kind: 'error', message: 'Usage: threadgarden pair' }, join(dir, 'nowhere')),
    ).toBe(2);
    expect(lines).toEqual(['Usage: threadgarden pair']);
  });

  it('uses the injected connection', async () => {
    const calls: string[] = [];
    const code = await runCli(
      { kind: 'devices' },
      {
        dataDir: join(dir, 'data'),
        out: () => {},
        connect: async () => ({
          call: async (method: string) => {
            calls.push(method);
            return [];
          },
          close: () => {},
        }),
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['devices.list']);
  });
});
