/**
 * Opt-in spike against the installed `claude` and the user's own login
 * (`pnpm --filter @threadgarden/service test:real -- mcp`, which sets THREADGARDEN_REAL=1).
 * It sends no prompt, only control requests, in fresh temp folders `claude` has never opened.
 *
 * Kept as the "recheck on every SDK update" check for the Query methods SDK 0.3.314 has but
 * does not declare (`mcpAuthenticate`, `mcpClearAuth`, `mcpSubmitOAuthCallbackUrl`); findings
 * are in docs/superpowers/specs/2026-11-22-mcp-servers-spike-results.md. The sign-in link is
 * requested from a public server (Linear) that uses OAuth with dynamic client registration;
 * no sign-in is ever completed. Values that look like secrets are redacted before printing,
 * and the user's own servers are only counted, never named.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession, SDKMessage } from '../../src/sdk/adapter.js';
import { findInstalledClaude } from '../../src/sdk/claude-path.js';
import { RealAdapter, buildSessionEnv } from '../../src/sdk/real-adapter.js';

const REAL = process.env.THREADGARDEN_REAL === '1';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-mcp-server.mjs',
);
const OAUTHY_URL = 'https://mcp.linear.app/mcp';

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

/** The Query's MCP controls, three of them undeclared in the SDK's types. */
type McpControls = {
  mcpServerStatus(): Promise<McpStatus[]>;
  reconnectMcpServer(name: string): Promise<unknown>;
  toggleMcpServer(name: string, enabled: boolean): Promise<unknown>;
  mcpAuthenticate(name: string, redirectUri?: string): Promise<unknown>;
  mcpClearAuth(name: string): Promise<unknown>;
  mcpSubmitOAuthCallbackUrl(name: string, callbackUrl: string): Promise<unknown>;
};

const SECRET_PARAMS =
  /\b(code|state|client_id|code_challenge|access_token|refresh_token|token)=[^&"\s\\]+/gi;
const redact = (s: string): string => s.replace(SECRET_PARAMS, '$1=<redacted>');

const report = (label: string, value: unknown): void => {
  console.log(`[threadgarden-real] ${label}: ${redact(JSON.stringify(value) ?? 'undefined')}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms)),
  ]);

/** The call's value, or its error text verbatim, so a refusal is evidence rather than a failure. */
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

const sha = (file: string): string =>
  existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
    : 'missing';

const claudeJsonPath = path.join(os.homedir(), '.claude.json');
/** Entries of `~/.claude.json`'s `projects` whose key names one of `dirs` (read only). */
const claudeJsonEntries = (dirs: string[]): Record<string, unknown> => {
  if (!existsSync(claudeJsonPath)) return {};
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const wanted = dirs.map(norm);
  const projects =
    (JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as { projects?: Record<string, unknown> })
      .projects ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(projects)) {
    if (wanted.includes(norm(k))) out[path.basename(k)] = v;
  }
  return out;
};

/** The environment of a service started outside any Claude Code session. */
const withoutClaudeVars = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^CLAUDE(CODE|_CODE|_AGENT|_PID|_EFFORT)/i.test(k)),
  );

type Open = {
  session: AgentSession;
  ctl: McpControls;
  sessionId: string;
  inits: SDKMessage[];
};

describe.skipIf(!REAL)('MCP controls on the real Claude Code (THREADGARDEN_REAL=1)', () => {
  const adapter = new RealAdapter();
  let claudePath = '';
  const dirs: string[] = [];
  const opened: Open[] = [];
  let phase = 'S1';
  let main: Open;
  let dir = '';
  let firstList: McpStatus[] = [];
  /** Every `type/subtype` that is not `system/init`, by the phase it arrived in. */
  const phaseSeen = new Map<string, Set<string>>();

  const writeLocal = (d: string, obj: object): void => {
    mkdirSync(path.join(d, '.claude'), { recursive: true });
    writeFileSync(path.join(d, '.claude', 'settings.local.json'), JSON.stringify(obj, null, 2));
  };

  const mkproj = (settingsLocal?: object): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'threadgarden-mcp-'));
    dirs.push(d);
    writeFileSync(
      path.join(d, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [FIXTURE] },
          oauthy: { type: 'http', url: OAUTHY_URL },
        },
      }),
    );
    if (settingsLocal) writeLocal(d, settingsLocal);
    return d;
  };

  const open = (cwd: string, o: { resume?: string; cleanEnv?: boolean } = {}): Open => {
    const sessionId = o.resume ?? randomUUID();
    const session = adapter.start({
      cwd,
      ...(o.resume === undefined ? { sessionId } : { resume: o.resume }),
      env: buildSessionEnv(o.cleanEnv ? withoutClaudeVars(process.env) : process.env, null),
      claudePath,
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Threadgarden real test' }),
    });
    const inits: SDKMessage[] = [];
    void (async () => {
      try {
        for await (const m of session.messages) {
          const sub = (m as { subtype?: string }).subtype;
          const key = sub ? `${m.type}/${sub}` : m.type;
          if (key === 'system/init') {
            inits.push(m);
            continue;
          }
          if (!phaseSeen.has(phase)) phaseSeen.set(phase, new Set());
          phaseSeen.get(phase)!.add(key);
        }
      } catch {
        // closed
      }
    })();
    const o2: Open = {
      session,
      // RealSession keeps its Query private; the spike calls the Query's own methods.
      ctl: (session as unknown as { q: McpControls }).q,
      sessionId,
      inits,
    };
    opened.push(o2);
    return o2;
  };

  /** Status of every server, once none of `names` is `pending` (or after `ms`). */
  const list = async (o: Open, names: string[] = [], ms = 15_000): Promise<McpStatus[]> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const all = await withTimeout(o.ctl.mcpServerStatus(), 30_000, 'mcpServerStatus');
      const pending = all.some((s) => names.includes(s.name) && s.status === 'pending');
      if (!pending || Date.now() > deadline) return all;
      await sleep(500);
    }
  };
  const entry = (all: McpStatus[], name: string): McpStatus | undefined =>
    all.find((s) => s.name === name);

  beforeAll(async () => {
    const found = await findInstalledClaude(null);
    if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
    claudePath = found.path;
    report('claude', { version: found.version });
    dir = mkproj();
    main = open(dir);
  });

  afterAll(async () => {
    if (main) await attempt('clearAuth(oauthy) cleanup', () => main.ctl.mcpClearAuth('oauthy'));
    for (const o of opened) o.session.close();
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
    report('~/.claude.json entries left for the temp folders (not edited)', {
      count: Object.keys(claudeJsonEntries(dirs)).length,
      folders: dirs.length,
    });
  });

  it('S1 unapproved project server', async () => {
    const all = await list(main, ['echo', 'oauthy'], 5_000);
    firstList = all;
    report('S1 echo (before any approval)', summary(entry(all, 'echo')));
    report('S1 oauthy (before any approval)', summary(entry(all, 'oauthy')));
    report('S1 total servers', all.length);
    await sleep(2_000);
    report('S1 system/init arrived without a prompt', main.inits.length > 0);
    report(
      'S1 system/init.mcp_servers',
      main.inits.map((m) => {
        const servers =
          (m as { mcp_servers?: { name: string; status: string }[] }).mcp_servers ?? [];
        return {
          echo: servers.find((s) => s.name === 'echo') ?? 'absent',
          oauthy: servers.find((s) => s.name === 'oauthy') ?? 'absent',
          total: servers.length,
        };
      }),
    );
    expect(Array.isArray(all)).toBe(true);
  });

  it('S8 sources', () => {
    const counts = new Map<string, number>();
    for (const s of firstList) {
      const k = `source=${s.source} scope=${s.scope} status=${s.status} config.type=${s.config?.type}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    report('S8 (source, scope, status, config.type) counts', Object.fromEntries(counts));
    expect(firstList.length).toBeGreaterThan(0);
  });

  it('S2 approval picked up live, S3 folder trust', async () => {
    phase = 'S2';
    writeLocal(dir, { enabledMcpjsonServers: ['echo'] });
    await sleep(1_000);
    report(
      'S2 echo right after writing the approval (no reconnect)',
      summary(entry(await list(main, ['echo'], 3_000), 'echo')),
    );
    report(
      'S2 reconnect(echo) returned',
      await attempt('reconnect', () => main.ctl.reconnectMcpServer('echo')),
    );
    const after = entry(await list(main, ['echo'], 10_000), 'echo');
    report('S2 echo after reconnect', summary(after));
    // S3: the folder was never opened by claude, so it is untrusted.
    report('S3 server connected in the untrusted folder', after?.status === 'connected');

    // A new process on the same session id (no transcript exists: no prompt was sent).
    try {
      const resumed = open(dir, { resume: main.sessionId });
      const all = await list(resumed, ['echo'], 10_000);
      report('S2 resumed process: echo', summary(entry(all, 'echo')));
      resumed.session.close();
    } catch (err) {
      report('S2 resume with the same session id failed', String(err));
    }
    const fresh = open(dir);
    report(
      'S2 brand-new process in the same folder: echo',
      summary(entry(await list(fresh, ['echo'], 10_000), 'echo')),
    );
    fresh.session.close();
  });

  it('S4 sign-in', async () => {
    phase = 'S4';
    writeLocal(dir, { enabledMcpjsonServers: ['echo', 'oauthy'] });
    await sleep(500);
    await attempt('reconnect(oauthy)', () => main.ctl.reconnectMcpServer('oauthy'));
    report(
      'S4 oauthy after approval + reconnect',
      summary(entry(await list(main, ['oauthy'], 15_000), 'oauthy')),
    );
    report(
      'S4 authenticate(oauthy)',
      await attempt('authenticate', () => main.ctl.mcpAuthenticate('oauthy')),
    );
    report(
      "S4 authenticate(oauthy, 'http://localhost:1/cb')",
      await attempt('authenticate+uri', () =>
        main.ctl.mcpAuthenticate('oauthy', 'http://localhost:1/cb'),
      ),
    );
    report(
      'S4 submitCallback(no code)',
      await attempt('submit', () =>
        main.ctl.mcpSubmitOAuthCallbackUrl('oauthy', 'http://localhost/callback'),
      ),
    );
    report(
      'S4 submitCallback(code=x&state=wrong)',
      await attempt('submit2', () =>
        main.ctl.mcpSubmitOAuthCallbackUrl(
          'oauthy',
          'http://localhost/callback?code=x&state=wrong',
        ),
      ),
    );
    report(
      'S4 clearAuth(oauthy)',
      await attempt('clearAuth', () => main.ctl.mcpClearAuth('oauthy')),
    );
    report(
      'S4 oauthy after clearAuth',
      summary(entry(await list(main, ['oauthy'], 3_000), 'oauthy')),
    );
  });

  it('S6 toggle', async () => {
    phase = 'S6';
    const local = path.join(dir, '.claude', 'settings.local.json');
    const shared = path.join(dir, '.claude', 'settings.json');
    const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
    const snap = (): Record<string, string> => ({
      projectLocal: sha(local),
      projectShared: sha(shared),
      userSettings: sha(userSettings),
      claudeJsonEntry: JSON.stringify(claudeJsonEntries([dir])),
    });
    const before = snap();
    report(
      'S6 toggle(echo, false)',
      await attempt('toggle off', () => main.ctl.toggleMcpServer('echo', false)),
    );
    await sleep(1_000);
    const after = snap();
    report('S6 files changed by toggle(echo,false)', {
      projectLocal: before.projectLocal !== after.projectLocal,
      projectShared: before.projectShared !== after.projectShared,
      userSettings: before.userSettings !== after.userSettings,
      claudeJsonEntry: before.claudeJsonEntry !== after.claudeJsonEntry,
    });
    report('S6 ~/.claude.json project entry after', JSON.parse(after.claudeJsonEntry!));
    if (existsSync(local))
      report('S6 settings.local.json after', JSON.parse(readFileSync(local, 'utf8')));
    report('S6 echo in this process', summary(entry(await list(main, [], 1_000), 'echo')));
    const fresh = open(dir);
    report(
      'S6 echo in a fresh process',
      summary(entry(await list(fresh, ['echo'], 10_000), 'echo')),
    );
    fresh.session.close();
    report(
      'S6 toggle(echo, true)',
      await attempt('toggle on', () => main.ctl.toggleMcpServer('echo', true)),
    );
    await sleep(1_000);
    report('S6 echo after toggle on', summary(entry(await list(main, ['echo'], 10_000), 'echo')));
    const back = snap();
    report('S6 files changed by toggle on (vs. off)', {
      projectLocal: after.projectLocal !== back.projectLocal,
      claudeJsonEntry: after.claudeJsonEntry !== back.claudeJsonEntry,
    });
  });

  it('S7 rejected', async () => {
    phase = 'S7';
    const d = mkproj({ disabledMcpjsonServers: ['echo'] });
    const o = open(d);
    report(
      'S7 echo in a folder with it in disabledMcpjsonServers',
      summary(entry(await list(o, ['echo'], 8_000), 'echo')),
    );
    writeLocal(d, { enabledMcpjsonServers: ['echo'] });
    await sleep(1_000);
    report(
      'S7 after moving it to enabled (no reconnect)',
      summary(entry(await list(o, ['echo'], 3_000), 'echo')),
    );
    report(
      'S7 reconnect(echo)',
      await attempt('reconnect', () => o.ctl.reconnectMcpServer('echo')),
    );
    report('S7 after reconnect', summary(entry(await list(o, ['echo'], 10_000), 'echo')));
    o.session.close();
  });

  it('S9 a folder whose approved list names only other servers', async () => {
    phase = 'S9';
    const d = mkproj({ enabledMcpjsonServers: ['some-other-server'] });
    const o = open(d);
    const all = await list(o, ['echo'], 10_000);
    report(
      'S9 echo with enabledMcpjsonServers naming only another server',
      summary(entry(all, 'echo')),
    );
    o.session.close();
    const d2 = mkproj();
    const clean = open(d2, { cleanEnv: true });
    report(
      'S9 echo, no approval anywhere, environment without CLAUDE* variables',
      summary(entry(await list(clean, ['echo'], 10_000), 'echo')),
    );
    clean.session.close();
  });

  it('S5 status messages', () => {
    report(
      'S5 non-init SDK messages by phase',
      Object.fromEntries([...phaseSeen].map(([k, v]) => [k, [...v]])),
    );
    expect(true).toBe(true);
  });
});
