import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@threadgarden/protocol';
import { addJsonArgs, cliMcpConfig, maskValues, removeArgs } from '../../src/mcp/config.js';

const FAKE = `
import { appendFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  appendFileSync(process.env.TG_LOG, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: { TG_PROBE: process.env.TG_PROBE, CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH },
  }) + '\\n');
  const mode = process.env.TG_MODE;
  if (mode === 'refuse') {
    process.stderr.write('\\x1b[31mMCP server sentry already exists in local config\\x1b[0m\\n');
    process.exit(1);
  }
  if (mode === 'hang') setInterval(() => {}, 1000);
  else process.exit(0);
});
if (process.env.TG_MODE === 'hang') setInterval(() => {}, 1000);
`;

const setup = (mode = 'ok') => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-mcpcfg-'));
  const script = path.join(dir, 'fake-claude.mjs');
  const log = path.join(dir, 'log.jsonl');
  writeFileSync(script, FAKE);
  writeFileSync(log, '');
  const runs = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l)
      .map(
        (l) =>
          JSON.parse(l) as {
            argv: string[];
            cwd: string;
            stdin: string;
            env: {
              TG_PROBE?: string;
              CLAUDECODE?: string;
              CLAUDE_CODE_ENTRYPOINT?: string;
              CLAUDE_CODE_GIT_BASH_PATH?: string;
            };
          },
      );
  const make = (timeoutMs?: number) =>
    cliMcpConfig({
      claude: async () => ({ path: script }),
      env: () => ({ ...process.env, TG_LOG: log, TG_MODE: mode, TG_PROBE: 'probe-1' }),
      timeoutMs,
    });
  return { dir, runs, make };
};

const config: McpServerConfig = {
  type: 'http',
  url: 'https://mcp.sentry.dev/mcp',
  headers: { Authorization: 'Bearer SECRET' },
};

describe('cliMcpConfig', () => {
  it('add passes the JSON on stdin, never in the arguments', async () => {
    const { dir, runs, make } = setup();
    await make().add({ cwd: dir, scope: 'local', name: 'sentry', config });
    const [r] = runs();
    expect(r!.argv).toEqual(addJsonArgs('sentry', 'local'));
    expect(JSON.parse(r!.stdin)).toEqual(config);
    expect(r!.argv.join(' ')).not.toContain('Bearer SECRET');
    expect(path.resolve(r!.cwd).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    expect(r!.env.TG_PROBE).toBe('probe-1');
  });

  it('remove runs mcp remove with the scope', async () => {
    const { dir, runs, make } = setup();
    await make().remove({ cwd: dir, scope: 'user', name: 'sentry' });
    expect(runs()[0]!.argv).toEqual(removeArgs('sentry', 'user'));
    expect(removeArgs('sentry', 'user')).toEqual([
      'mcp',
      'remove',
      '--scope',
      'user',
      '--',
      'sentry',
    ]);
    expect(addJsonArgs('sentry', 'local')).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'local',
      '--',
      'sentry',
      '-',
    ]);
  });

  it('strips CLAUDECODE and CLAUDE_CODE_* from the child env', async () => {
    const { dir, runs, make } = setup();
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'x';
    try {
      await make().remove({ cwd: dir, scope: 'user', name: 'sentry' });
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
    expect(runs()[0]!.env).toEqual({ TG_PROBE: 'probe-1' });
  });

  it('keeps CLAUDE_CODE_GIT_BASH_PATH in the child env', async () => {
    const { dir, runs, make } = setup();
    process.env.CLAUDE_CODE_GIT_BASH_PATH = '/opt/git/bin/bash';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'x';
    try {
      await make().remove({ cwd: dir, scope: 'user', name: 'sentry' });
    } finally {
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
    expect(runs()[0]!.env).toEqual({
      TG_PROBE: 'probe-1',
      CLAUDE_CODE_GIT_BASH_PATH: '/opt/git/bin/bash',
    });
  });

  it("a refusal rejects with Claude Code's words", async () => {
    const { dir, make } = setup('refuse');
    await expect(make().add({ cwd: dir, scope: 'local', name: 'sentry', config })).rejects.toThrow(
      /^MCP server sentry already exists in local config$/,
    );
  });

  it('without claude it says CLAUDE_MISSING', async () => {
    const m = cliMcpConfig({
      claude: async () => ({ detail: 'Claude Code was not found' }),
      env: () => ({}),
    });
    await expect(m.remove({ cwd: '.', scope: 'user', name: 'x' })).rejects.toMatchObject({
      code: 'CLAUDE_MISSING',
      message: 'Claude Code was not found',
    });
  });

  it('a claude that never exits times out', async () => {
    const { dir, make } = setup('hang');
    await expect(make(200).remove({ cwd: dir, scope: 'user', name: 'sentry' })).rejects.toThrow(
      "Claude Code didn't answer in 30 s.",
    );
  });
});

describe('maskValues', () => {
  it('hides every header and env value', () => {
    expect(maskValues('x Bearer SECRET y', config)).toBe('x ••• y');
    expect(
      maskValues('a k b', { type: 'stdio', command: 'c', args: [], env: { K: 'k', E: '' } }),
    ).toBe('a ••• b');
  });
});
