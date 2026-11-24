/**
 * Opt-in spike against the installed `claude` and the user's own login
 * (`pnpm --filter @threadgarden/service test:real mcp-config.real`, which sets THREADGARDEN_REAL=1).
 * It sends no prompt. It drives `claude mcp add-json` / `remove` the way the service will (no shell,
 * the chat's folder as cwd, an environment without CLAUDE* variables) and watches a live session's
 * `mcpServerStatus()`. Findings are in docs/superpowers/specs/2026-11-24-mcp-add-server-spike-results.md.
 *
 * Only temp folders and `tg-spike-*` servers are touched, except `--scope user`, the one write to the
 * owner's real ~/.claude.json: every user-scope server added here is removed again in `afterAll`, and
 * the run reports loudly if one is left. Secret values are fake and never printed.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession } from '../../src/sdk/adapter.js';
import { findInstalledClaude } from '../../src/sdk/claude-path.js';
import { RealAdapter, buildSessionEnv } from '../../src/sdk/real-adapter.js';

const REAL = process.env.THREADGARDEN_REAL === '1';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-mcp-server.mjs',
);
const SECRET = 'SPIKE-SECRET-VALUE';

type McpStatus = {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  source?: string;
  config?: { type?: string };
  serverInfo?: { name: string; version: string };
  tools?: { name: string }[];
};
type Ctl = {
  mcpServerStatus(): Promise<McpStatus[]>;
  reconnectMcpServer(name: string): Promise<unknown>;
};
type Cli = { code: number | null; stdout: string; stderr: string };
type Scope = 'local' | 'user' | 'project';

const SECRET_PARAMS = /\b(code|state|client_id|access_token|refresh_token|token)=[^&"\s\\]+/gi;
const redact = (s: string): string =>
  s.replace(SECRET_PARAMS, '$1=<redacted>').split(SECRET).join('<secret>');
const report = (label: string, value: unknown): void => {
  console.log(`[threadgarden-real] ${label}: ${redact(JSON.stringify(value) ?? 'undefined')}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};
const attempt = async (what: string, fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: await withTimeout(fn(), 30_000, what) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
const summary = (s: McpStatus | undefined): unknown =>
  s === undefined
    ? 'absent'
    : {
        status: s.status,
        source: s.source,
        scope: s.scope,
        configType: s.config?.type,
        error: s.error,
        serverInfo: s.serverInfo,
        tools: s.tools?.map((t) => t.name),
      };

const withoutClaudeVars = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^CLAUDE(CODE|_CODE|_AGENT|_PID|_EFFORT)/i.test(k)),
  );

describe.skipIf(!REAL)('adding and removing MCP servers (THREADGARDEN_REAL=1)', () => {
  const adapter = new RealAdapter();
  let claudePath = '';
  const env = buildSessionEnv(withoutClaudeVars(process.env), null);
  const dirs: string[] = [];
  const sessions: AgentSession[] = [];
  const userNames: string[] = [];
  const localCleanup: { name: string; cwd: string }[] = [];
  const run = `tg-spike-${randomBytes(4).toString('hex')}`;
  const stdioJson = { type: 'stdio', command: process.execPath, args: [FIXTURE] };

  const mkdir = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'threadgarden-mcpcfg-'));
    dirs.push(d);
    return d;
  };

  /** `claude <args>` with no shell, the folder as cwd, optional stdin; never rejects. */
  const claude = (args: string[], cwd: string, stdin?: string, timeout = 60_000): Promise<Cli> =>
    new Promise((resolve) => {
      const child = execFile(
        claudePath,
        args,
        { cwd, env, timeout, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
          resolve({ code, stdout, stderr: stderr + (err && code === null ? String(err) : '') });
        },
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
      else child.stdin?.end();
    });

  const add = async (name: string, json: object | string, scope: Scope, cwd: string) => {
    if (scope === 'user') userNames.push(name);
    else localCleanup.push({ name, cwd });
    const body = typeof json === 'string' ? json : JSON.stringify(json);
    return claude(['mcp', 'add-json', name, '-', '--scope', scope], cwd, body);
  };
  const remove = (name: string, scope: Scope, cwd: string) =>
    claude(['mcp', 'remove', name, '--scope', scope], cwd);

  const open = (cwd: string): { session: AgentSession; ctl: Ctl } => {
    const session = adapter.start({
      cwd,
      sessionId: randomUUID(),
      env,
      claudePath,
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Threadgarden real test' }),
    });
    sessions.push(session);
    void (async () => {
      try {
        for await (const _ of session.messages) {
          // drain
        }
      } catch {
        // closed
      }
    })();
    return { session, ctl: (session as unknown as { q: Ctl }).q };
  };

  /** All statuses, once none is `pending` (or after `ms`). */
  const settled = async (ctl: Ctl, ms = 20_000): Promise<McpStatus[]> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const all = await withTimeout(ctl.mcpServerStatus(), 30_000, 'mcpServerStatus');
      if (!all.some((s) => s.status === 'pending') || Date.now() > deadline) return all;
      await sleep(500);
    }
  };
  /** Poll until `name` is present (want=true) or gone (want=false); the final entry. */
  const poll = async (ctl: Ctl, name: string, want: boolean, ms = 10_000) => {
    const start = Date.now();
    const deadline = start + ms;
    let at: number | null = null;
    for (;;) {
      const all = await withTimeout(ctl.mcpServerStatus(), 30_000, 'mcpServerStatus');
      const e = all.find((s) => s.name === name);
      if (at === null && (e !== undefined) === want) at = Date.now() - start;
      if (at !== null && (!want || e?.status !== 'pending')) {
        return { appearedAfterMs: at, entry: summary(e) };
      }
      if (Date.now() > deadline) return { appearedAfterMs: at, entry: summary(e) };
      await sleep(500);
    }
  };
  const freshEntry = async (cwd: string, name: string) => {
    const o = open(cwd);
    const all = await settled(o.ctl);
    o.session.close();
    return summary(all.find((s) => s.name === name));
  };
  const afterSteps = async (label: string, ctl: Ctl, name: string, want: boolean, cwd: string) => {
    report(`${label} (a) polling 10 s`, await poll(ctl, name, want));
    report(`${label} (b) reconnect`, await attempt('reconnect', () => ctl.reconnectMcpServer(name)));
    report(`${label} (b) status after reconnect`, await poll(ctl, name, want, 8_000));
    report(`${label} (c) new process in the folder`, await freshEntry(cwd, name));
  };

  // State shared by the sequential checks.
  let dirL = '';
  let dirP = '';
  let sL: { session: AgentSession; ctl: Ctl };
  let sP: { session: AgentSession; ctl: Ctl };
  const nameL = `${run}-l`;
  const nameP = `${run}-p`;
  const nameU = `${run}-u`;

  beforeAll(async () => {
    const found = await findInstalledClaude(null);
    if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
    claudePath = found.path;
    report('claude', { version: found.version });
  });

  afterAll(async () => {
    for (const s of sessions) s.close();
    // The one write to the real ~/.claude.json: take every user-scope server back out.
    for (const n of userNames) {
      const r = await remove(n, 'user', os.tmpdir());
      const g = await claude(['mcp', 'get', n], os.tmpdir());
      const gone = /No MCP server found/i.test(g.stdout + g.stderr) || g.code !== 0;
      report(`cleanup user-scope ${n}`, { removeExit: r.code, getExit: g.code, gone });
      if (!gone) report('CLEANUP FAILED: a tg-spike server is still in ~/.claude.json user scope', n);
    }
    for (const { name, cwd } of localCleanup) {
      if (existsSync(cwd)) await remove(name, 'local', cwd);
    }
    for (const d of dirs) {
      for (let tries = 0; ; tries++) {
        try {
          rmSync(d, { recursive: true, force: true });
          break;
        } catch (err) {
          if (tries >= 40) {
            report('cleanup', `left ${d}: ${String(err)}`);
            break;
          }
          await sleep(250);
        }
      }
    }
    // Read only: Claude Code may have recorded the folders in ~/.claude.json.
    const file = path.join(os.homedir(), '.claude.json');
    if (existsSync(file)) {
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
      const wanted = dirs.map(norm);
      const projects =
        (JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, unknown> })
          .projects ?? {};
      report(
        '~/.claude.json project entries left for the temp folders (not edited)',
        Object.keys(projects).filter((k) => wanted.includes(norm(k))).length,
      );
    }
  });

  it('C1 add-json reads stdin', async () => {
    const d = mkdir();
    const name = `${run}-c1`;
    const r = await add(name, stdioJson, 'local', d);
    report('C1 add-json - (stdin), scope local', r);
    const g = await claude(['mcp', 'get', name], d);
    report('C1 mcp get', g);
    const r2 = await remove(name, 'local', d);
    report('C1 remove', r2);
    expect(r.code, JSON.stringify(r)).toBe(0);
  });

  it('C2 live add (local, project)', async () => {
    dirL = mkdir();
    dirP = mkdir();
    sL = open(dirL);
    sP = open(dirP);
    report('C2 servers before (local folder, count)', (await settled(sL.ctl)).length);
    await settled(sP.ctl);
    const rl = await add(nameL, stdioJson, 'local', dirL);
    report('C2 add local', rl);
    await afterSteps('C2 local', sL.ctl, nameL, true, dirL);
    const rp = await add(nameP, stdioJson, 'project', dirP);
    report('C2 add project', rp);
    const mcpJson = path.join(dirP, '.mcp.json');
    report(
      'C2 .mcp.json keys',
      existsSync(mcpJson)
        ? Object.keys(
            (JSON.parse(readFileSync(mcpJson, 'utf8')) as { mcpServers?: object }).mcpServers ?? {},
          )
        : 'no file',
    );
    await afterSteps('C2 project', sP.ctl, nameP, true, dirP);
    expect(rl.code).toBe(0);
    expect(rp.code).toBe(0);
  });

  it('C3 user scope (add, then remove, with a live session)', async () => {
    const d = mkdir();
    const s = open(d);
    await settled(s.ctl);
    const r = await add(nameU, stdioJson, 'user', d);
    report('C3 add user', r);
    await afterSteps('C3 user add', s.ctl, nameU, true, d);
    const rr = await remove(nameU, 'user', d);
    report('C3 remove user', rr);
    await afterSteps('C3 user remove', s.ctl, nameU, false, d);
    expect(r.code).toBe(0);
  });

  it('C4 live remove (local, project)', async () => {
    const rl = await remove(nameL, 'local', dirL);
    report('C4 remove local', rl);
    await afterSteps('C4 local', sL.ctl, nameL, false, dirL);
    const rp = await remove(nameP, 'project', dirP);
    report('C4 remove project', rp);
    await afterSteps('C4 project', sP.ctl, nameP, false, dirP);
    expect(rl.code).toBe(0);
  });

  it('C5 values never come back', async () => {
    const d = mkdir();
    const s = open(d);
    await settled(s.ctl);
    const h = `${run}-h`;
    const e = `${run}-e`;
    const ra = await add(
      h,
      { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { 'X-Tg-Spike': SECRET } },
      'local',
      d,
    );
    const rb = await add(e, { ...stdioJson, env: { TG_SPIKE: SECRET } }, 'local', d);
    const has = (v: unknown): boolean => (JSON.stringify(v) ?? '').includes(SECRET);
    report('C5 CLI output has the value (http add / stdio add)', {
      http: has(ra),
      stdio: has(rb),
    });
    const g1 = await claude(['mcp', 'get', h], d);
    const g2 = await claude(['mcp', 'get', e], d);
    report('C5 mcp get has the value (http / stdio)', { http: has(g1), stdio: has(g2) });
    report('C5 mcp get http (redacted)', g1);
    await attempt('reconnect', () => s.ctl.reconnectMcpServer(e));
    await attempt('reconnect', () => s.ctl.reconnectMcpServer(h));
    await poll(s.ctl, e, true);
    await poll(s.ctl, h, true);
    const all = await settled(s.ctl);
    report('C5 mcpServerStatus has the value, whole entries (http / stdio)', {
      http: has(all.find((x) => x.name === h)),
      stdio: has(all.find((x) => x.name === e)),
    });
    report('C5 status entries', [
      summary(all.find((x) => x.name === h)),
      summary(all.find((x) => x.name === e)),
    ]);
    const list = await claude(['mcp', 'list'], d, undefined, 120_000);
    report('C5 mcp list has the value', has(list));
    expect(ra.code).toBe(0);
  });

  it('C6 refusals', async () => {
    const d = mkdir();
    const n = `${run}-c6`;
    const ok = await add(n, stdioJson, 'local', d);
    report('C6 success', ok);
    report('C6 duplicate, same scope', await add(n, stdioJson, 'local', d));
    report(
      'C6 same name, other scope (project) while local exists',
      await add(n, stdioJson, 'project', d),
    );
    report('C6 remove project copy', await remove(n, 'project', d));
    report('C6 remove from scope lacking the name (user)', await remove(n, 'user', d));
    report('C6 remove from scope lacking the name (project)', await remove(n, 'project', d));
    const bad = (t: string) => ({ type: 'http', url: t });
    report('C6 bad url "not a url"', await add(`${run}-b1`, bad('not a url'), 'local', d));
    report('C6 bad url ftp', await add(`${run}-b2`, bad('ftp://example.com'), 'local', d));
    report(
      'C6 bad json (does it echo the input?)',
      await add(`${run}-b3`, '{"type": "http", "url": SPIKE-INPUT-ECHO', 'local', d),
    );
    report('C6 bad json: not json at all', await add(`${run}-b4`, 'SPIKE-INPUT-ECHO', 'local', d));
    report('C6 bad shape (no command)', await add(`${run}-b5`, { type: 'stdio' }, 'local', d));
    for (const nm of ['a b', 'a.b', '-x', 'ä', 'a_b-1']) {
      const r = await add(nm, stdioJson, 'local', d);
      report(`C6 name ${JSON.stringify(nm)}`, r);
      if (nm === '-x') {
        report(
          'C6 name "-x" after "--"',
          await claude(
            ['mcp', 'add-json', '--scope', 'local', '--', nm, '-'],
            d,
            JSON.stringify(stdioJson),
          ),
        );
      }
    }
    expect(ok.code).toBe(0);
  });
});
