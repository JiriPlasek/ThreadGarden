/**
 * Opt-in spike against the installed `claude`
 * (`pnpm --filter @threadgarden/service test:real claude-login`, which sets THREADGARDEN_REAL=1).
 *
 * Kept as the "recheck on every SDK update" check for the Claude sign-in controls SDK 0.3.314
 * has but does not declare (`claudeAuthenticate`, `claudeOAuthCallback`,
 * `claudeOAuthWaitForCompletion`); findings are in
 * docs/superpowers/specs/2026-11-27-claude-sign-in-spike-results.md.
 *
 * Every process runs with `CLAUDE_CONFIG_DIR` set to a fresh temp folder (and no `CLAUDE*` /
 * `ANTHROPIC*` variables inherited), so Claude Code starts NOT signed in and the user's own
 * login is never read or touched. `beforeAll` proves that first: if `accountInfo()` shows an
 * account, nothing else runs. A prompt is only sent in L3 (no login, or a fake dead one) and in
 * L4 (the owner's fresh sign-in, in the temp folder). Codes, states and full links are never
 * printed: links as host/path and parameter names, objects as their keys.
 *
 * L4 completes a real sign-in and needs the owner: run it with THREADGARDEN_REAL_LOGIN=1. It
 * writes the full link to `<tmp>/tg-login-spike/link.txt`, waits up to 10 minutes for the
 * pasted code in `<tmp>/tg-login-spike/code.txt`, and deletes both files afterwards.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountInfo, AgentSession, SDKMessage } from '../../src/sdk/adapter.js';
import { findInstalledClaude } from '../../src/sdk/claude-path.js';
import { RealAdapter, buildSessionEnv } from '../../src/sdk/real-adapter.js';

const REAL = process.env.THREADGARDEN_REAL === '1';
const LOGIN = process.env.THREADGARDEN_REAL_LOGIN === '1';

/** The Query's Claude sign-in controls, undeclared in SDK 0.3.314's types. */
type LoginControls = {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<unknown>;
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>;
  claudeOAuthWaitForCompletion(): Promise<unknown>;
  accountInfo(): Promise<AccountInfo>;
};

const LOGIN_METHODS = [
  'claudeAuthenticate',
  'claudeOAuthCallback',
  'claudeOAuthWaitForCompletion',
] as const;

// ── redaction ──

/** Values this run must never print (states, codes, full links), filled as they appear. */
const secrets = new Set<string>();
const remember = (s: string | undefined): void => {
  if (s && s.length >= 4) secrets.add(s);
};

/** `https://host/path?{param names}`: never a parameter value. */
const urlShape = (u: string): string => {
  try {
    const url = new URL(u);
    const names = [...url.searchParams.keys()];
    const redirect = url.searchParams.get('redirect_uri');
    let out = `${url.protocol}//${url.host}${url.pathname}`;
    if (names.length) out += `?{${names.join(',')}}`;
    if (redirect) {
      try {
        const r = new URL(redirect);
        out += ` redirect_uri=${r.protocol}//${r.host}${r.pathname}`;
      } catch {
        out += ' redirect_uri=<not a URL>';
      }
    }
    return out;
  } catch {
    return '<unparsable URL>';
  }
};

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const SECRET_PARAMS =
  /\b(code|state|client_id|code_challenge|code_verifier|access_token|refresh_token|token)=[^&"\s\\]+/gi;

/** Free text with links reduced to their shape and known secrets removed. */
const scrubText = (s: string): string => {
  let out = s.replace(URL_RE, (u) => urlShape(u)).replace(SECRET_PARAMS, '$1=<redacted>');
  for (const x of secrets) out = out.split(x).join('<redacted>');
  return out;
};

/** A value reduced to its shape: keys kept; links as host/path; token-like strings as lengths. */
const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(shape);
  if (v === null || typeof v !== 'object') {
    if (typeof v !== 'string') return v;
    if (/^https?:\/\//.test(v)) return `<url ${urlShape(v)}>`;
    if (!/\s/.test(v) && v.length >= 16) return `<token-like string, ${v.length} chars>`;
    return scrubText(v);
  }
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, shape(val)]),
  );
};

const report = (label: string, value: unknown): void => {
  console.log(`[threadgarden-real] ${label}: ${scrubText(JSON.stringify(value) ?? 'undefined')}`);
};

// ── helpers ──

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

type Attempt = { ok?: unknown; error?: string; ms: number };
/** The call's value, or its error text, so a refusal is evidence rather than a failure. */
const attempt = async (what: string, fn: () => Promise<unknown>, ms = 30_000): Promise<Attempt> => {
  const t0 = Date.now();
  try {
    return { ok: await withTimeout(fn(), ms, what), ms: Date.now() - t0 };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
};
const shown = (a: Attempt): unknown =>
  a.error !== undefined ? { error: scrubText(a.error), ms: a.ms } : { ok: shape(a.ok), ms: a.ms };

const sha = (file: string): string =>
  existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
    : 'missing';

/** No inherited Claude Code or Anthropic variable: no host session, token or API key leaks in. */
const isolatedEnv = (configDir: string): Record<string, string | undefined> => {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)),
  );
  return { ...buildSessionEnv(base, null), CLAUDE_CONFIG_DIR: configDir };
};

/** Every string value in `v` that is a link, with its key path. */
const findUrls = (v: unknown, at = ''): { key: string; url: string }[] => {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? [{ key: at, url: v }] : [];
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) =>
    findUrls(val, at ? `${at}.${k}` : k),
  );
};
/** The link the user opens by hand (the "manual" one when there are several). */
const manualLink = (v: unknown): string | undefined => {
  const urls = findUrls(v);
  return (urls.find((u) => /manual/i.test(u.key)) ?? urls[0])?.url;
};
const stateOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
};
const rememberAuth = (v: unknown): void => {
  for (const { url } of findUrls(v)) {
    remember(url);
    remember(stateOf(url));
    try {
      const u = new URL(url);
      for (const k of ['code_challenge', 'client_id']) remember(u.searchParams.get(k) ?? undefined);
    } catch {
      // not a URL
    }
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/state|code|verifier/i.test(k) && typeof val === 'string') remember(val);
    }
  }
};

const accountSummary = (a: AccountInfo | undefined): unknown =>
  a === undefined
    ? 'unavailable'
    : {
        emailDomain: a.email?.split('@')[1] ?? null,
        organization: a.organization === undefined ? 'absent' : 'present',
        subscriptionType: a.subscriptionType ?? null,
        tokenSource: a.tokenSource ?? null,
        apiKeySource: a.apiKeySource ?? null,
        apiProvider: a.apiProvider ?? null,
      };

type Proc = {
  name: string;
  session: AgentSession;
  ctl: LoginControls;
  sessionId: string;
  configDir: string;
  seen: string[];
  authStatus: { isAuthenticating: boolean; output: string[]; error?: string }[];
  results: SDKMessage[];
  assistantErrors: string[];
  assistantText: string[];
};

const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const listProjects = (): Set<string> =>
  new Set(existsSync(projectsDir) ? readdirSync(projectsDir) : []);
/** Transcripts named after one of `ids` anywhere under `~/.claude/projects` (read only). */
const transcriptsFor = (ids: string[]): number => {
  if (!existsSync(projectsDir)) return 0;
  let n = 0;
  for (const d of readdirSync(projectsDir)) {
    const full = path.join(projectsDir, d);
    let names: string[];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const id of ids) if (names.some((f) => f.startsWith(id))) n++;
  }
  return n;
};
/** File and folder names (never contents) in a config dir, two levels deep. */
const namesIn = (dir: string): string[] => {
  if (!existsSync(dir)) return ['<missing>'];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    out.push(e.isDirectory() ? `${e.name}/` : e.name);
    if (e.isDirectory() && e.name === 'projects') {
      for (const p of readdirSync(path.join(dir, e.name))) out.push(`projects/${p}/`);
    }
  }
  return out.sort();
};

const SPIKE_DIR = path.join(os.tmpdir(), 'tg-login-spike');
const LINK_FILE = path.join(SPIKE_DIR, 'link.txt');
const CODE_FILE = path.join(SPIKE_DIR, 'code.txt');

describe.skipIf(!REAL)(
  'Claude sign-in controls on the real Claude Code (THREADGARDEN_REAL=1)',
  () => {
    const adapter = new RealAdapter();
    let claudePath = '';
    let root = '';
    const opened: Proc[] = [];
    const projectsBefore = new Set<string>();
    const credentialsFile = path.join(os.homedir(), '.claude', '.credentials.json');
    let credentialsBefore = '';
    let isolated = false;
    let l1State: string | undefined;
    let l1Proc: Proc | undefined;

    const freshConfig = (label: string): string => {
      const d = path.join(root, `config-${label}`);
      mkdirSync(d, { recursive: true });
      return d;
    };

    const open = (name: string, configDir: string): Proc => {
      const sessionId = randomUUID();
      const work = path.join(root, `work-${name}`);
      mkdirSync(work, { recursive: true });
      const session = adapter.start({
        cwd: work,
        sessionId,
        env: isolatedEnv(configDir),
        claudePath,
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'Threadgarden real test' }),
      });
      const p: Proc = {
        name,
        session,
        // RealSession keeps its Query private; the spike calls the Query's own methods.
        ctl: (session as unknown as { q: LoginControls }).q,
        sessionId,
        configDir,
        seen: [],
        authStatus: [],
        results: [],
        assistantErrors: [],
        assistantText: [],
      };
      void (async () => {
        try {
          for await (const m of session.messages) {
            const sub = (m as { subtype?: string }).subtype;
            const key = sub ? `${m.type}/${sub}` : m.type;
            if (!p.seen.includes(key)) p.seen.push(key);
            if (m.type === 'auth_status') {
              const a = m as unknown as {
                isAuthenticating: boolean;
                output: string[];
                error?: string;
              };
              p.authStatus.push({
                isAuthenticating: a.isAuthenticating,
                output: a.output,
                ...(a.error === undefined ? {} : { error: a.error }),
              });
            }
            if (m.type === 'result') p.results.push(m);
            if (m.type === 'assistant') {
              const am = m as unknown as {
                error?: string;
                message?: { content?: { type: string; text?: string }[] };
              };
              if (am.error) p.assistantErrors.push(am.error);
              for (const c of am.message?.content ?? [])
                if (c.type === 'text' && c.text) p.assistantText.push(c.text);
            }
          }
        } catch (err) {
          if (!p.seen.includes('stream-threw')) p.seen.push('stream-threw');
          p.assistantErrors.push(`stream: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      opened.push(p);
      return p;
    };

    const sendAndWait = async (
      p: Proc,
      text: string,
      ms = 150_000,
    ): Promise<SDKMessage | undefined> => {
      const before = p.results.length;
      p.session.send({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      const deadline = Date.now() + ms;
      while (p.results.length === before) {
        if (Date.now() > deadline || p.seen.includes('stream-threw')) return undefined;
        await sleep(250);
      }
      await sleep(500);
      return p.results[p.results.length - 1];
    };

    const resultSummary = (r: SDKMessage | undefined): unknown => {
      if (r === undefined) return 'no result';
      const x = r as unknown as {
        subtype?: string;
        is_error?: boolean;
        result?: string;
        errors?: string[];
        api_error_status?: number | null;
      };
      return {
        subtype: x.subtype,
        is_error: x.is_error,
        result: typeof x.result === 'string' ? scrubText(x.result).slice(0, 300) : x.result,
        errors: x.errors?.map(scrubText),
        api_error_status: x.api_error_status,
      };
    };

    const procSummary = (p: Proc): unknown => ({
      authStatus: p.authStatus.map((a) => ({
        isAuthenticating: a.isAuthenticating,
        output: a.output.map(scrubText),
        error: a.error === undefined ? undefined : scrubText(a.error),
      })),
      assistantErrors: p.assistantErrors.map(scrubText),
      seen: p.seen,
    });

    beforeAll(async () => {
      const found = await findInstalledClaude(null);
      if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
      claudePath = found.path;
      report('claude', { version: found.version });
      root = mkdtempSync(path.join(os.tmpdir(), 'threadgarden-login-'));
      for (const d of listProjects()) projectsBefore.add(d);
      credentialsBefore = sha(credentialsFile);

      // Guard: CLAUDE_CONFIG_DIR must be honoured, or nothing below may run.
      const cfg = freshConfig('guard');
      const g = open('guard', cfg);
      const info = await attempt('accountInfo (guard)', () => g.ctl.accountInfo(), 60_000);
      report('GUARD accountInfo in a fresh CLAUDE_CONFIG_DIR', shown(info));
      const a = info.ok as AccountInfo | undefined;
      await sleep(1_000);
      report('GUARD names in the temp config dir', namesIn(cfg));
      g.session.close();
      if (info.error !== undefined || a?.email || a?.organization || a?.subscriptionType) {
        throw new Error(
          'BLOCKED: a fresh CLAUDE_CONFIG_DIR still shows an account (or accountInfo failed); not running anything against the real login',
        );
      }
      isolated = true;
    });

    afterAll(async () => {
      for (const p of opened) p.session.close();
      await sleep(1_000);
      rmSync(SPIKE_DIR, { recursive: true, force: true });
      if (root) {
        for (let tries = 0; ; tries++) {
          try {
            rmSync(root, { recursive: true, force: true });
            break;
          } catch (err) {
            if (tries >= 40) {
              report('cleanup', `left the temp root: ${String(err)}`);
              break;
            }
            await sleep(250);
          }
        }
        report('cleanup: temp root and link/code files removed', {
          root: !existsSync(root),
          spikeDir: !existsSync(SPIKE_DIR),
        });
      }
      const after = listProjects();
      report('~/.claude/projects after (read only)', {
        newFolders: [...after].filter((d) => !projectsBefore.has(d)).length,
        transcriptsWithThisRunsSessionIds: transcriptsFor(opened.map((p) => p.sessionId)),
      });
      report('~/.claude/.credentials.json unchanged (hash compared, never read out)', {
        before: credentialsBefore === 'missing' ? 'missing' : 'present',
        unchanged: sha(credentialsFile) === credentialsBefore,
      });
    });

    it('L1 start', async () => {
      expect(isolated).toBe(true);
      const p = open('L1', freshConfig('L1'));
      l1Proc = p;
      for (const m of LOGIN_METHODS) expect(typeof p.ctl[m], `Query.${m}`).toBe('function');
      const r = await attempt('claudeAuthenticate(true)', () => p.ctl.claudeAuthenticate(true));
      rememberAuth(r.ok);
      report('L1 claudeAuthenticate(true)', shown(r));
      const urls = findUrls(r.ok);
      report(
        'L1 links in the response (key → host/path, parameter names, redirect_uri host/path)',
        urls.map((u) => ({ key: u.key, url: urlShape(u.url) })),
      );
      const link = manualLink(r.ok);
      l1State = stateOf(link);
      const urlStates = urls.map((u) => stateOf(u.url));
      report('L1 state', {
        inManualLink: l1State !== undefined,
        length: l1State?.length,
        charset:
          l1State === undefined ? null : /^[A-Za-z0-9_-]+$/.test(l1State) ? 'base64url' : 'other',
        sameStateInEveryLink: urlStates.every((s) => s === urlStates[0]),
        stateKeyInResponse: Object.keys((r.ok as object) ?? {}).filter((k) => /state/i.test(k)),
      });
      await sleep(1_000);
      report('L1 messages so far', procSummary(p));
      // Booleans only: a failing assertion prints its received value, which must never be raw SDK text.
      expect(r.error === undefined, scrubText(r.error ?? '')).toBe(true);
      expect(link).toBeDefined();
    });

    it('L2 wrong code', async () => {
      expect(isolated).toBe(true);
      const p = l1Proc!;
      expect(l1State, 'L1 must have produced a state').toBeDefined();
      const wrong = await attempt('claudeOAuthCallback(wrong, state)', () =>
        p.ctl.claudeOAuthCallback('wrong', l1State!),
      );
      report("L2 claudeOAuthCallback('wrong', <L1 state>)", shown(wrong));
      const wait = await attempt(
        'claudeOAuthWaitForCompletion',
        () => p.ctl.claudeOAuthWaitForCompletion(),
        10_000,
      );
      report('L2 claudeOAuthWaitForCompletion() after the wrong code (10 s timeout)', shown(wait));

      // A second start in the same process: does it replace the first (new state)?
      const again = await attempt('claudeAuthenticate(true) again', () =>
        p.ctl.claudeAuthenticate(true),
      );
      rememberAuth(again.ok);
      const state2 = stateOf(manualLink(again.ok));
      report('L2b claudeAuthenticate(true) again in the same process', {
        result: shown(again),
        newState: state2 !== undefined && state2 !== l1State,
      });
      const mismatch = await attempt('claudeOAuthCallback(wrong, other state)', () =>
        p.ctl.claudeOAuthCallback('wrong', 'not-the-state'),
      );
      report("L2b claudeOAuthCallback('wrong', 'not-the-state')", shown(mismatch));
      const oldState = await attempt('claudeOAuthCallback(wrong, L1 state)', () =>
        p.ctl.claudeOAuthCallback('wrong', l1State!),
      );
      report("L2b claudeOAuthCallback('wrong', <L1's now replaced state>)", shown(oldState));
      const wait2 = await attempt(
        'claudeOAuthWaitForCompletion 2',
        () => p.ctl.claudeOAuthWaitForCompletion(),
        10_000,
      );
      report('L2b claudeOAuthWaitForCompletion() (10 s timeout)', shown(wait2));
      // A wait that is already pending when the wrong code arrives.
      const again2 = await attempt('claudeAuthenticate(true) for L2d', () =>
        p.ctl.claudeAuthenticate(true),
      );
      rememberAuth(again2.ok);
      const state3 = stateOf(manualLink(again2.ok));
      const pendingWait = attempt(
        'pending wait',
        () => p.ctl.claudeOAuthWaitForCompletion(),
        20_000,
      );
      await sleep(3_000);
      const waitedBeforeCode = await Promise.race([
        pendingWait.then(() => 'settled'),
        sleep(10).then(() => 'still pending'),
      ]);
      const wrong3 = await attempt('claudeOAuthCallback(wrong, state) during wait', () =>
        p.ctl.claudeOAuthCallback('wrong', state3 ?? ''),
      );
      report('L2d wait before any code, after 3 s', waitedBeforeCode);
      report(
        "L2d claudeOAuthCallback('wrong', <its state>) while a wait is pending",
        shown(wrong3),
      );
      report('L2d the pending claudeOAuthWaitForCompletion() then', shown(await pendingWait));

      // No flow at all: a fresh process.
      const q = open('L2c', freshConfig('L2c'));
      report(
        'L2c claudeOAuthWaitForCompletion() with no flow started',
        shown(await attempt('wait no flow', () => q.ctl.claudeOAuthWaitForCompletion(), 10_000)),
      );
      report(
        "L2c claudeOAuthCallback('wrong', 'x') with no flow started",
        shown(await attempt('callback no flow', () => q.ctl.claudeOAuthCallback('wrong', 'x'))),
      );
      await sleep(1_000);
      report('L2 messages (L1/L2 process)', procSummary(p));
      report('L2c messages', procSummary(q));
      q.session.close();
      expect(
        wrong.error !== undefined || wait.error !== undefined,
        'a wrong code must not succeed',
      ).toBe(true);
    });

    it('L3 no login, and a dead login', async () => {
      expect(isolated).toBe(true);
      // No login at all.
      const cfg = freshConfig('L3');
      const p = open('L3', cfg);
      report(
        'L3 accountInfo before',
        accountSummary((await attempt('ai', () => p.ctl.accountInfo())).ok as AccountInfo),
      );
      const r = await sendAndWait(p, 'hi');
      report("L3 result of 'hi' with no login", resultSummary(r));
      report('L3 messages', procSummary(p));
      report('L3 names in the temp config dir after the turn', namesIn(cfg));
      const start = await attempt('claudeAuthenticate after failure', () =>
        p.ctl.claudeAuthenticate(true),
      );
      rememberAuth(start.ok);
      report(
        'L3 claudeAuthenticate(true) in the same process, after the failed turn',
        shown(start),
      );

      // A dead login: a fake, expired claude.ai login whose refresh token is not valid.
      const dead = freshConfig('L3dead');
      writeFileSync(
        path.join(dead, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'threadgarden-spike-dead-access',
            refreshToken: 'threadgarden-spike-dead-refresh',
            expiresAt: Date.now() - 86_400_000,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
            subscriptionType: null,
          },
        }),
      );
      const d = open('L3dead', dead);
      report(
        'L3dead accountInfo before',
        accountSummary((await attempt('ai', () => d.ctl.accountInfo())).ok as AccountInfo),
      );
      const rd = await sendAndWait(d, 'hi');
      report("L3dead result of 'hi' with an expired login", resultSummary(rd));
      report('L3dead messages', procSummary(d));
      const startDead = await attempt('claudeAuthenticate after dead login', () =>
        d.ctl.claudeAuthenticate(true),
      );
      rememberAuth(startDead.ok);
      report(
        'L3dead claudeAuthenticate(true) in the same process, after the failed turn',
        shown(startDead),
      );
      report(
        'L3dead accountInfo after the failed turn',
        accountSummary((await attempt('ai', () => d.ctl.accountInfo())).ok as AccountInfo),
      );
      p.session.close();
      d.session.close();
      expect(r).toBeDefined();
    });

    it.skipIf(!LOGIN)('L4 complete (manual, owner present)', { timeout: 20 * 60_000 }, async () => {
      expect(isolated).toBe(true);
      const cfg = freshConfig('L4');
      const a = open('L4a', cfg);
      const b = open('L4b', cfg);
      // Both processes are up before the sign-in starts.
      report(
        'L4 a accountInfo before',
        accountSummary((await attempt('a', () => a.ctl.accountInfo())).ok as AccountInfo),
      );
      report(
        'L4 b accountInfo before',
        accountSummary((await attempt('b', () => b.ctl.accountInfo())).ok as AccountInfo),
      );
      try {
        const start = await attempt('claudeAuthenticate(true)', () =>
          a.ctl.claudeAuthenticate(true),
        );
        rememberAuth(start.ok);
        report('L4 claudeAuthenticate(true)', shown(start));
        const link = manualLink(start.ok);
        expect(link, 'no link').toBeDefined();
        const urlState = stateOf(link);
        mkdirSync(SPIKE_DIR, { recursive: true });
        rmSync(CODE_FILE, { force: true });
        writeFileSync(LINK_FILE, `${link!}\n`);
        console.log(
          `[threadgarden-real] L4 the sign-in link is in ${LINK_FILE}. Open it, approve, and save what claude.ai shows into ${CODE_FILE} (waiting up to 10 minutes).`,
        );
        const deadline = Date.now() + 10 * 60_000;
        // A wrong code ends the flow, so a half-written file must not be submitted: the
        // content counts only once two consecutive polls read the same non-empty text.
        let pasted = '';
        let previous = '';
        while (Date.now() < deadline) {
          const now = existsSync(CODE_FILE) ? readFileSync(CODE_FILE, 'utf8').trim() : '';
          if (now !== '' && now === previous) {
            pasted = now;
            break;
          }
          previous = now;
          await sleep(1_000);
        }
        rmSync(CODE_FILE, { force: true });
        rmSync(LINK_FILE, { force: true });
        expect(pasted !== '', 'no code arrived in 10 minutes').toBe(true);
        remember(pasted);
        const hash = pasted.indexOf('#');
        const code = hash >= 0 ? pasted.slice(0, hash) : pasted;
        const pastedState = hash >= 0 ? pasted.slice(hash + 1) : undefined;
        remember(code);
        remember(pastedState);
        report('L4 CODE_SHAPE (what claude.ai showed)', {
          shape: hash >= 0 ? 'code#state' : 'code',
          codeLength: code.length,
          codeCharset: /^[A-Za-z0-9_-]+$/.test(code) ? 'base64url' : 'other',
          pastedStateEqualsLinkState: pastedState === undefined ? null : pastedState === urlState,
        });
        // The wait is started first (as the service would hold it), then the code is submitted.
        const waiting = attempt('wait', () => a.ctl.claudeOAuthWaitForCompletion(), 120_000);
        await sleep(500);
        const cb = await attempt('claudeOAuthCallback', () =>
          a.ctl.claudeOAuthCallback(code, pastedState ?? urlState ?? ''),
        );
        report('L4 claudeOAuthCallback(code, state)', shown(cb));
        const done = await waiting;
        report(
          'L4 WAIT_RESULT claudeOAuthWaitForCompletion() (started before the code)',
          shown(done),
        );
        report(
          'L4 claudeOAuthWaitForCompletion() called again after completion',
          shown(await attempt('wait again', () => a.ctl.claudeOAuthWaitForCompletion(), 10_000)),
        );
        await sleep(2_000);
        report(
          'L4 ACCOUNT_AFTER a accountInfo (same process)',
          accountSummary((await attempt('a', () => a.ctl.accountInfo())).ok as AccountInfo),
        );
        report('L4 a auth_status count', a.authStatus.length);
        report('L4 a messages', procSummary(a));
        report('L4 names in the temp config dir after the sign-in', namesIn(cfg));
        // OTHERS_PICK_UP: b was running before the sign-in.
        report(
          'L4 b accountInfo after (no restart)',
          accountSummary((await attempt('b', () => b.ctl.accountInfo())).ok as AccountInfo),
        );
        const rb = await sendAndWait(b, 'Reply with the single word OK. Do not use any tools.');
        report('L4 OTHERS_PICK_UP b result (started before the sign-in)', resultSummary(rb));
        report('L4 b messages', procSummary(b));
        const c = open('L4c', cfg);
        report(
          'L4 c accountInfo (new process after the sign-in)',
          accountSummary((await attempt('c', () => c.ctl.accountInfo())).ok as AccountInfo),
        );
        c.session.close();
        expect(done.error === undefined, scrubText(done.error ?? '')).toBe(true);
      } finally {
        rmSync(SPIKE_DIR, { recursive: true, force: true });
        a.session.close();
        b.session.close();
      }
    });
  },
);
