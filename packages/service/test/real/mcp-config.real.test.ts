/**
 * Opt-in spike against the installed `claude` and the user's own login
 * (`pnpm --filter @threadgarden/service test:real mcp-config.real`, which sets THREADGARDEN_REAL=1).
 * It sends no prompt. It drives `claude mcp add-json` / `remove` the way the service will (no shell,
 * the chat's folder as cwd, an environment without CLAUDECODE / CLAUDE_CODE_* variables) and watches
 * a live session's `mcpServerStatus()`. Findings are in
 * docs/superpowers/specs/2026-11-24-mcp-add-server-spike-results.md. The `expect`s pin the constants
 * the build relies on, so a CLI update that changes one fails here.
 *
 * Only temp folders and `tg-spike-*` servers are touched, except `--scope user`, the one write to the
 * owner's real ~/.claude.json: every user-scope server added here is removed again in `afterAll`, which
 * fails the run if one is left (checked with `claude mcp list`, never `mcp get`, which prints header
 * values). Secret values are fake and never printed; the home and temp folders are redacted.
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
type Live = { session: AgentSession; ctl: Ctl };

/** Every spelling of `dir` that can appear in text or in JSON-escaped text. */
const spellings = (dir: string): string[] => {
  const fwd = dir.replace(/\\/g, '/');
  const back = dir.replace(/\//g, '\\');
  return [...new Set([back.replace(/\\/g, '\\\\'), back, fwd])].filter((s) => s.length > 3);
};
const PRIVATE_DIRS: [string, string][] = [
  [os.tmpdir(), '<tmp>'],
  [os.homedir(), '<home>'],
];
const SECRET_PARAMS = /\b(code|state|client_id|access_token|refresh_token|token)=[^&"\s\\]+/gi;
const redact = (s: string): string => {
  let out = s.replace(SECRET_PARAMS, '$1=<redacted>').split(SECRET).join('<secret>');
  for (const [dir, label] of PRIVATE_DIRS) {
    for (const sp of spellings(dir)) out = out.split(sp).join(label);
  }
  return out;
};
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
const attempt = async (
  what: string,
  fn: () => Promise<unknown>,
): Promise<{ ok?: unknown; error?: string }> => {
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

/** The environment of a service started outside any Claude Code session (the ruling: these two only). */
const withoutClaudeVars = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_)/i.test(k)));

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
  const claude = (
    args: string[],
    cwd: string,
    stdin?: string,
    o: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
  ): Promise<Cli> =>
    new Promise((resolve) => {
      const child = execFile(
        claudePath,
        args,
        { cwd, env: o.env ?? env, timeout: o.timeout ?? 60_000, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
          resolve({ code, stdout, stderr: stderr + (err && code === null ? String(err) : '') });
        },
      );
      child.stdin?.end(stdin);
    });

  const add = async (
    name: string,
    json: object | string,
    scope: Scope,
    cwd: string,
    e?: NodeJS.ProcessEnv,
  ) => {
    if (scope === 'user') userNames.push(name);
    else localCleanup.push({ name, cwd });
    const body = typeof json === 'string' ? json : JSON.stringify(json);
    // `--` so that a name starting with `-` is not read as an option.
    return claude(['mcp', 'add-json', '--scope', scope, '--', name, '-'], cwd, body, { env: e });
  };
  const remove = (name: string, scope: Scope, cwd: string) =>
    claude(['mcp', 'remove', '--scope', scope, '--', name], cwd);

  const open = (cwd: string): Live => {
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
        for await (const m of session.messages) void m;
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
  /** Poll until `name` is present (want=true) or gone (want=false); the last entry seen. */
  const poll = async (ctl: Ctl, name: string, want: boolean, ms = 10_000) => {
    const start = Date.now();
    const deadline = start + ms;
    let at: number | null = null;
    for (;;) {
      const all = await withTimeout(ctl.mcpServerStatus(), 30_000, 'mcpServerStatus');
      const e = all.find((s) => s.name === name);
      if (at === null && (e !== undefined) === want) at = Date.now() - start;
      if ((at !== null && (!want || e?.status !== 'pending')) || Date.now() > deadline) {
        return { appearedAfterMs: at, entry: e };
      }
      await sleep(500);
    }
  };
  const afterSteps = async (label: string, live: Live, name: string, want: boolean, cwd: string) => {
    const a = await poll(live.ctl, name, want);
    report(`${label} (a) polling 10 s`, { appearedAfterMs: a.appearedAfterMs, entry: summary(a.entry) });
    const rc = await attempt('reconnect', () => live.ctl.reconnectMcpServer(name));
    report(`${label} (b) reconnect`, rc);
    const b = await poll(live.ctl, name, want, 8_000);
    report(`${label} (b) status after reconnect`, { entry: summary(b.entry) });
    const fresh = open(cwd);
    const c = (await settled(fresh.ctl)).find((s) => s.name === name);
    fresh.session.close();
    report(`${label} (c) new process in the folder`, summary(c));
    return { a: a.entry, rc, b: b.entry, c };
  };

  // State shared by the sequential checks.
  let dirL = '';
  let dirP = '';
  let sL: Live | undefined;
  let sP: Live | undefined;
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
    const problems: string[] = [];
    // The one write to the real ~/.claude.json: take every user-scope server back out.
    for (const n of userNames) {
      const r = await remove(n, 'user', os.tmpdir());
      const missing = r.code === 1 && /No MCP server named/.test(r.stderr);
      report(`cleanup remove user-scope ${n}`, { exit: r.code, alreadyGone: missing });
      if (r.code !== 0 && !missing) problems.push(`remove ${n} failed: ${r.stderr}`);
    }
    if (userNames.length > 0) {
      const list = await claude(['mcp', 'list'], os.tmpdir(), undefined, { timeout: 180_000 });
      const left = userNames.filter((n) => list.stdout.includes(n));
      report('cleanup `claude mcp list` still names user-scope tg-spike servers', {
        exit: list.code,
        left,
      });
      if (list.code !== 0) problems.push(`mcp list failed (exit ${list.code}): cannot verify`);
      if (left.length > 0) problems.push(`STILL IN ~/.claude.json (user scope): ${left.join(', ')}`);
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
      report('~/.claude.json project entries left for the temp folders (not edited)', {
        entries: Object.keys(projects).filter((k) => wanted.includes(norm(k))).length,
        folders: dirs.length,
      });
    }
    if (problems.length > 0) throw new Error(`CLEANUP FAILED: ${problems.join('; ')}`);
  }, 300_000);

  it('C1 add-json reads stdin (and is refused inside a Claude Code session)', async () => {
    const d = mkdir();
    const name = `${run}-c1`;
    const r = await add(name, stdioJson, 'local', d);
    report('C1 add-json - (stdin), scope local', r);
    const g = await claude(['mcp', 'get', name], d); // output not printed: `get` shows header values
    report('C1 mcp get', { exit: g.code, connected: /Connected/.test(g.stdout) });
    report('C1 remove', await remove(name, 'local', d));
    expect(r).toEqual({
      code: 0,
      stdout: `Added stdio MCP server ${name} to local config\n`,
      stderr: '',
    });
    expect(g.code).toBe(0);

    const inSession = await add(`${run}-c1s`, stdioJson, 'local', d, {
      ...env,
      CLAUDE_CODE_CHILD_SESSION: '1',
    });
    report('C1 add-json - with CLAUDE_CODE_CHILD_SESSION=1 in the environment', inSession);
    expect(inSession.code).toBe(1);
    expect(inSession.stderr).toMatch(/refused inside a Claude Code session/);
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
    expect(rl.code).toBe(0);
    const l = await afterSteps('C2 local', sL, nameL, true, dirL);
    const rp = await add(nameP, stdioJson, 'project', dirP);
    report('C2 add project', rp);
    expect(rp.code).toBe(0);
    const mcpJson = path.join(dirP, '.mcp.json');
    const keys = existsSync(mcpJson)
      ? Object.keys(
          (JSON.parse(readFileSync(mcpJson, 'utf8')) as { mcpServers?: object }).mcpServers ?? {},
        )
      : [];
    report('C2 .mcp.json keys', keys);
    expect(keys).toEqual([nameP]);
    const p = await afterSteps('C2 project', sP, nameP, true, dirP);

    // ADD_SEEN_BY = 'reconnect': polling alone never sees it; reconnect connects it; a restart too.
    for (const [r, scope] of [
      [l, 'local'],
      [p, 'project'],
    ] as const) {
      expect(r.a, `${scope}: polling sees an added server (ADD_SEEN_BY would be 'status')`).toBeUndefined();
      expect(r.rc.error, `${scope}: reconnect`).toBeUndefined();
      expect(r.b?.status).toBe('connected');
      expect(r.b?.source).toBe(scope);
      expect(r.b?.scope).toBe(scope);
      expect(r.b?.config?.type).toBe('stdio');
      expect(r.c?.status).toBe('connected');
    }
  });

  it('C3 user scope (add, then remove, with a live session)', async () => {
    const d = mkdir();
    const s = open(d);
    await settled(s.ctl);
    const r = await add(nameU, stdioJson, 'user', d);
    report('C3 add user', r);
    expect(r.code).toBe(0);
    const added = await afterSteps('C3 user add', s, nameU, true, d);
    expect(added.a).toBeUndefined();
    expect(added.b?.status).toBe('connected');
    expect(added.b?.source).toBe('user');
    expect(added.b?.scope).toBe('user');
    expect(added.c?.status).toBe('connected');
    const rr = await remove(nameU, 'user', d);
    report('C3 remove user', rr);
    expect(rr.code).toBe(0);
    const gone = await afterSteps('C3 user remove', s, nameU, false, d);
    expect(gone.a?.status, 'a removed server stays listed as a connected ghost').toBe('connected');
    expect(gone.rc.error).toMatch(/Server not found/);
    expect(gone.b?.status).toBe('connected');
    expect(gone.c).toBeUndefined();
  });

  it('C4 live remove (local, project)', async () => {
    expect(sL && sP, 'C2 must have opened the live sessions').toBeTruthy();
    for (const [live, name, scope, cwd] of [
      [sL!, nameL, 'local', dirL],
      [sP!, nameP, 'project', dirP],
    ] as const) {
      const r = await remove(name, scope, cwd);
      report(`C4 remove ${scope}`, r);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Removed MCP server ${name} from ${scope} config`);
      const g = await afterSteps(`C4 ${scope}`, live, name, false, cwd);
      expect(g.a?.status, `${scope}: ghost`).toBe('connected');
      expect(g.rc.error).toMatch(/Server not found/);
      expect(g.b?.status).toBe('connected');
      expect(g.c, `${scope}: a new process no longer has it`).toBeUndefined();
    }
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
    report('C5 CLI output has the value (http add / stdio add)', { http: has(ra), stdio: has(rb) });
    const g1 = await claude(['mcp', 'get', h], d);
    const g2 = await claude(['mcp', 'get', e], d);
    report('C5 mcp get has the value (http / stdio)', { http: has(g1), stdio: has(g2) });
    await attempt('reconnect', () => s.ctl.reconnectMcpServer(e));
    await attempt('reconnect', () => s.ctl.reconnectMcpServer(h));
    await poll(s.ctl, e, true);
    await poll(s.ctl, h, true);
    const all = await settled(s.ctl);
    const eh = all.find((x) => x.name === h);
    const es = all.find((x) => x.name === e);
    report('C5 mcpServerStatus has the value, whole entries (http / stdio)', {
      http: has(eh),
      stdio: has(es),
    });
    report('C5 status entries', [summary(eh), summary(es)]);
    const list = await claude(['mcp', 'list'], d, undefined, { timeout: 180_000 });
    report('C5 mcp list has the value', has(list));
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    expect(has(ra) || has(rb), 'add output').toBe(false);
    expect(has(g1), '`mcp get` prints header values').toBe(true);
    expect(eh, 'http entry listed').toBeDefined();
    expect(eh?.config?.type).toBe('http');
    expect(has(eh), 'VALUES_IN_STATUS: the http entry carries the header value').toBe(true);
    expect(es, 'stdio entry listed').toBeDefined();
    expect(has(es), 'the stdio entry carries no env value').toBe(false);
    expect(has(list), '`mcp list` carries no value').toBe(false);
  });

  it('C6 refusals and the name rule', async () => {
    const d = mkdir();
    const n = `${run}-c6`;
    const ok = await add(n, stdioJson, 'local', d);
    report('C6 success', ok);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe('');
    // eslint-disable-next-line no-control-regex
    expect(ok.stdout + ok.stderr, 'no ANSI colour').not.toMatch(/\u001b\[/);

    const dupLocal = await add(n, stdioJson, 'local', d);
    report('C6 duplicate, same scope (local)', dupLocal);
    const projFirst = await add(n, stdioJson, 'project', d);
    report('C6 same name in another scope (project) while local exists', projFirst);
    const dupProject = await add(n, stdioJson, 'project', d);
    report('C6 duplicate, same scope (project)', dupProject);
    const rmProject = await remove(n, 'project', d);
    report('C6 remove project copy', rmProject);
    const rmUser = await remove(n, 'user', d);
    report('C6 remove from scope lacking the name (user)', rmUser);
    const rmProject2 = await remove(n, 'project', d);
    report('C6 remove from scope lacking the name (project)', rmProject2);
    const rmLocal = await remove(n, 'local', d);
    report('C6 remove local', rmLocal);
    const rmLocal2 = await remove(n, 'local', d);
    report('C6 remove local again (lacks the name)', rmLocal2);

    expect(dupLocal.code).toBe(1);
    expect(dupLocal.stdout).toBe('');
    expect(dupLocal.stderr).toBe(`MCP server ${n} already exists in local config\n`);
    expect(projFirst.code, 'the same name in another scope is accepted').toBe(0);
    expect(dupProject.code).toBe(1);
    expect(dupProject.stderr).toBe(`MCP server ${n} already exists in .mcp.json\n`);
    expect(rmProject.code).toBe(0);
    expect(rmUser).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `No MCP server named "${n}" in user scope\n`,
    });
    expect(rmProject2).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `No MCP server named "${n}" in .mcp.json\n`,
    });
    expect(rmLocal.code).toBe(0);
    expect(rmLocal2).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `No MCP server named "${n}" in local scope\n`,
    });

    const bad = (url: string) => ({ type: 'http', url });
    const url1 = await add(`${run}-b1`, bad('not a url'), 'local', d);
    const url2 = await add(`${run}-b2`, bad('ftp://example.com'), 'local', d);
    report('C6 bad url "not a url"', url1);
    report('C6 bad url ftp', url2);
    expect(url1.code, 'the CLI accepts a bad URL').toBe(0);
    expect(url2.code, 'the CLI accepts ftp://').toBe(0);

    const json1 = await add(`${run}-b3`, '{"type": "http", "url": SPIKE-INPUT-ECHO', 'local', d);
    const json2 = await add(`${run}-b4`, 'SPIKE-INPUT-ECHO', 'local', d);
    const shape = await add(`${run}-b5`, { type: 'stdio' }, 'local', d);
    report('C6 bad json (does it echo the input?)', json1);
    report('C6 not json at all', json2);
    report('C6 bad shape (no command)', shape);
    for (const r of [json1, json2]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(
        'Invalid configuration: not a JSON object. Check its quotes, commas and braces.\n',
      );
      expect(r.stderr, 'the input is not echoed').not.toContain('SPIKE-INPUT-ECHO');
    }
    expect(shape.code).toBe(1);
    expect(shape.stderr).toBe('Invalid configuration: command: expected string, received undefined\n');

    // NAME_RULE: letters, numbers, hyphens, underscores. Probes carry the run id where the rule allows.
    const probes: [string, boolean][] = [
      [`${run} a b`, false],
      [`${run}.b`, false],
      [`-${run}-x`, true],
      [`${run}-ä`, false],
      [`${run}-a_b-1`, true],
    ];
    for (const [nm, accepted] of probes) {
      const r = await add(nm, stdioJson, 'local', d);
      report(`C6 name ${JSON.stringify(nm)}`, r);
      if (accepted) {
        expect(r.code, nm).toBe(0);
      } else {
        expect(r.code, nm).toBe(1);
        expect(r.stderr).toBe(
          `Invalid name ${nm}. Names can only contain letters, numbers, hyphens, and underscores.\n`,
        );
      }
    }
    // Without `--`, a leading `-` is read as an option.
    const asOption = await claude(
      ['mcp', 'add-json', '--scope', 'local', `-${run}-y`, '-'],
      d,
      JSON.stringify(stdioJson),
    );
    report('C6 leading dash without "--"', asOption);
    expect(asOption.code).toBe(1);
    expect(asOption.stderr).toMatch(/unknown option/);
  });
});
