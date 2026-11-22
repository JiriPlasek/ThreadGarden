/**
 * Opt-in spike for the `!` commands feature (THREADGARDEN_REAL=1; use
 * `pnpm --filter @threadgarden/service test:real -- shell`). It runs against the installed
 * `claude` and the user's own login, in a throwaway git folder, and prints its
 * findings with a `[threadgarden-real]` prefix for
 * docs/superpowers/specs/2026-11-22-shell-commands-spike-results.md.
 *
 * C1 and C2 drive the interactive `claude` in a pseudo-terminal (the PTY package
 * the feature ships) and then read the transcript. Reading the raw JSONL lines
 * is for this spike only: the product never opens transcripts, it reads them
 * through the SDK. C3 to C5 use `RealAdapter` like the service does. Prompts are
 * kept tiny.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentSession,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '../../src/sdk/adapter.js';
import { findInstalledClaude } from '../../src/sdk/claude-path.js';
import { RealAdapter, buildSessionEnv } from '../../src/sdk/real-adapter.js';

const REAL = process.env.THREADGARDEN_REAL === '1';

const report = (label: string, value: unknown): void => {
  console.log(`[threadgarden-real] ${label}: ${JSON.stringify(value)}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
};

const pty = createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty');

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-B]|\u001b[=>]/g;
const plain = (s: string): string => s.replace(ANSI, '');

/** The interactive `claude` in a pseudo-terminal. */
class Terminal {
  raw = '';
  private readonly term: import('@lydell/node-pty').IPty;
  exited = false;

  constructor(file: string, args: string[], cwd: string, env: Record<string, string | undefined>) {
    this.term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 160,
      rows: 50,
      cwd,
      env: env as Record<string, string>,
    });
    this.term.onData((d) => {
      this.raw += d;
    });
    this.term.onExit(() => {
      this.exited = true;
    });
  }

  text(): string {
    return plain(this.raw);
  }

  /** The screen text without any whitespace: the CLI moves the cursor instead of printing spaces. */
  flat(): string {
    return this.text().replace(/\s+/g, '');
  }

  write(s: string): void {
    this.term.write(s);
  }

  async waitText(re: RegExp, ms: number, from = 0): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (re.test(this.text().slice(from))) return true;
      await sleep(150);
    }
    return false;
  }

  /** Waits until nothing has been printed for `quiet` ms. */
  async idle(quiet: number, max: number): Promise<void> {
    const deadline = Date.now() + max;
    let last = this.raw.length;
    let since = Date.now();
    while (Date.now() < deadline) {
      await sleep(100);
      if (this.raw.length !== last) {
        last = this.raw.length;
        since = Date.now();
      } else if (Date.now() - since >= quiet) return;
    }
  }

  kill(): void {
    try {
      this.term.kill();
    } catch {
      // already gone
    }
  }
}

/**
 * This process's environment minus the markers a Claude Code parent leaves
 * (CLAUDE_CODE_CHILD_SESSION turns transcript saving off): what the service
 * sees when it is started from the desktop app or systemd.
 */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const inherited =
      /^(CLAUDECODE|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k) ||
      (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_GIT_BASH_PATH');
    if (!inherited) env[k] = v;
  }
  return env;
};

type RawLine = Record<string, unknown>;

/** The spike's one look inside a transcript: every JSONL line of one session. */
const rawTranscript = (sessionId: string): RawLine[] => {
  const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const projects = path.join(config, 'projects');
  for (const project of readdirSync(projects)) {
    const file = path.join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as RawLine);
    }
  }
  return [];
};

const contentText = (line: RawLine): string => {
  const message = line.message as { content?: unknown } | undefined;
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
};

const isBash = (line: RawLine): boolean => /<bash-(input|stdout|stderr)>/.test(contentText(line));

const clip = (s: string, n = 300): string =>
  s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;

/** How a transcript entry looks in the report: everything but the message body, which is clipped. */
const shown = (line: RawLine, n = 300): unknown => {
  const { message, ...rest } = line;
  void message;
  return { ...rest, content: clip(contentText(line), n) };
};

const bashLines = (sessionId: string): RawLine[] =>
  rawTranscript(sessionId).filter((l) => l.type === 'user' && isBash(l));

type Shape = 'one' | 'two';
let entryShape: Shape = 'two';

/** The user entries the CLI would write for a `!` command, in the shape C1 found. */
const bashEntry = (command: string, stdout: string, stderr = ''): string[] => {
  const input = `<bash-input>${command}</bash-input>`;
  const output = `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
  return entryShape === 'one' ? [input + output] : [input, output];
};

describe.skipIf(!REAL)('shell commands spike (THREADGARDEN_REAL=1)', () => {
  let dir = '';
  let claudePath = '';
  const adapter = new RealAdapter();

  beforeAll(async () => {
    const found = await findInstalledClaude(null);
    if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
    claudePath = found.path;
    report('claude', { version: found.version, platform: `${process.platform}-${process.arch}` });
    dir = mkdtempSync(path.join(os.tmpdir(), 'threadgarden-shell-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });

  afterAll(async () => {
    if (!dir) return;
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (attempt >= 40) {
          report('cleanup', `left ${dir}: ${String(err)}`);
          return;
        }
        await sleep(250);
      }
    }
  });

  /** Types `! <command>` into the interactive CLI and waits for its output to settle. */
  const typeBang = async (t: Terminal, command: string): Promise<void> => {
    const from = t.text().length;
    t.write('!');
    await sleep(500);
    for (const ch of command) {
      t.write(ch);
      await sleep(15);
    }
    await sleep(500);
    t.write('\r');
    await t.waitText(/⎿|Running|ms|\S/, 5_000, from);
    await sleep(2_000);
    await t.idle(2_500, 60_000);
  };

  /** Starts the interactive CLI with a chosen session id, past the folder-trust question. */
  const openInteractive = async (sessionId: string, extra: string[] = []): Promise<Terminal> => {
    const t = new Terminal(claudePath, ['--session-id', sessionId, ...extra], dir, {
      ...cleanEnv(),
      FORCE_COLOR: '0',
    });
    for (let i = 0; i < 6; i++) {
      await t.idle(2_500, 30_000);
      const text = t.flat();
      if (/Itrustthisfolder|Doyoutrust/i.test(text) && !/forshortcuts/.test(text)) {
        // "No, exit" is the highlighted answer in this version: move to "Yes, I trust".
        t.write('\u001b[B');
        await sleep(500);
        t.write('\r');
        continue;
      }
      if (/forshortcuts|bypasspermissions|accepteditson|automode/i.test(text)) break;
    }
    return t;
  };

  const quit = async (t: Terminal): Promise<void> => {
    t.write('\u0015/exit');
    await sleep(500);
    t.write('\r');
    await waitFor(() => t.exited, 15_000, 'the CLI to exit').catch(() => {
      t.kill();
    });
    await sleep(500);
  };

  /** The whole transcript in order: what followed each `!` entry (did a turn start?). */
  const sequence = (sessionId: string): unknown[] =>
    rawTranscript(sessionId)
      .filter((l) => ['user', 'assistant', 'api-request'].includes(String(l.type)))
      .map((l) => ({
        type: l.type,
        uuid: String(l.uuid).slice(0, 8),
        parent: String(l.parentUuid).slice(0, 8),
        ts: l.timestamp,
        keys: Object.keys(l)
          .filter((k) => !['parentUuid', 'uuid', 'timestamp', 'message'].includes(k))
          .join(','),
        text: clip(contentText(l).replace(/\s+/g, ' '), 90),
      }));

  it('C1 the CLI’s own ! entries (permission mode default)', async () => {
    const sessionId = randomUUID();
    const t = await openInteractive(sessionId, ['--permission-mode', 'default']);
    try {
      await typeBang(t, 'echo tg-c1');
      await typeBang(t, 'ls /nonexistent-tg');
    } finally {
      await quit(t);
    }
    const lines = bashLines(sessionId);
    report('C1 transcript sequence', sequence(sessionId));
    report(
      'C1 raw bash lines',
      lines.map((l) => shown(l, 500)),
    );
    const sdk = await adapter.getSessionMessages(sessionId, {});
    report(
      'C1 getSessionMessages',
      sdk.map((m) => ({
        type: m.type,
        uuid: m.uuid,
        content: clip(
          typeof m.message === 'object' && m.message !== null
            ? JSON.stringify((m.message as { content?: unknown }).content)
            : '',
          400,
        ),
      })),
    );
    const inputLine = lines.find((l) => contentText(l).includes('<bash-input>echo tg-c1'));
    expect(inputLine, 'a <bash-input> entry for echo tg-c1').toBeDefined();
    entryShape = contentText(inputLine!).includes('<bash-stdout>') ? 'one' : 'two';
    report('C1 ENTRY_SHAPE', entryShape);
    expect(lines.map(contentText).join('\n')).toContain('tg-c1');
  });

  it('C1b the same in the owner’s own permission mode', async () => {
    const sessionId = randomUUID();
    const t = await openInteractive(sessionId);
    try {
      report(
        'C1b screen before typing',
        clip(t.text().replace(/\s+/g, ' ').trim().slice(-300), 300),
      );
      await typeBang(t, 'echo tg-c1b');
    } finally {
      await quit(t);
    }
    report('C1b transcript sequence', sequence(sessionId));
    expect(bashLines(sessionId).map(contentText).join('\n')).toContain('tg-c1b');
  });

  it('C2 limit', async () => {
    const sessionId = randomUUID();
    const t = await openInteractive(sessionId, ['--permission-mode', 'default']);
    const sizes = [30_000, 30_001, 40_000];
    try {
      await typeBang(t, 'seq 1 200000');
      for (const n of sizes) await typeBang(t, `head -c ${n} /dev/zero | tr '\\0' a`);
      await typeBang(t, "printf '</bash-stdout>x'");
    } finally {
      await quit(t);
    }
    const entries = bashLines(sessionId).map(contentText);
    const outputs = entries.filter((c) => c.startsWith('<bash-stdout>'));
    const inner = (c: string): string =>
      /^<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(c)?.[1] ?? c;
    report(
      'C2 stdout entries',
      outputs.map((c) => ({
        entryLength: c.length,
        stdoutLength: inner(c).length,
        persisted: inner(c).startsWith('<persisted-output>'),
        head: clip(inner(c).slice(0, 80), 80),
        tail: inner(c).slice(-60),
      })),
    );
    const long = outputs.find((c) => inner(c).startsWith('<persisted-output>'));
    // The whole wrapper of the first (seq) entry, its saved-file path shortened to its folder names only.
    report(
      'C2 the seq entry in full',
      long?.replace(/\\\\Users\\\\[^\\\\]+/g, '\\\\Users\\\\<user>'),
    );
    report(
      'C2 TAGS_ESCAPED entries',
      entries.filter((c) => /bash-input>printf|&lt;/.test(c)).map((c) => clip(c, 300)),
    );
    expect(outputs.length).toBeGreaterThan(3);
  });

  // ---- SDK-driven checks ----

  type Rec = { at: number; m: SDKMessage };

  const startSession = (
    opts: { sessionId?: string; resume?: string; env?: Record<string, string | undefined> } = {},
  ): { session: AgentSession; seen: Rec[]; sessionId: string; ended: () => boolean } => {
    const sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
    const session = adapter.start({
      cwd: dir,
      ...(opts.resume ? { resume: opts.resume } : { sessionId }),
      env: opts.env ?? buildSessionEnv(cleanEnv(), null),
      claudePath,
      permissionMode: 'default',
      canUseTool: async (toolName, input): Promise<PermissionResult> =>
        toolName === 'Bash'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Threadgarden real test' },
    });
    const seen: Rec[] = [];
    let ended = false;
    void (async () => {
      try {
        for await (const m of session.messages) seen.push({ at: Date.now(), m });
      } finally {
        ended = true;
      }
    })();
    return { session, seen, sessionId, ended: () => ended };
  };

  const send = (
    session: AgentSession,
    text: string,
    extra: { shouldQuery?: boolean } = {},
  ): string => {
    const uuid = randomUUID();
    const m: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text } as SDKUserMessage['message'],
      parent_tool_use_id: null,
      uuid,
      ...(extra.shouldQuery === false ? { shouldQuery: false } : { priority: 'next' as const }),
    };
    session.send(m);
    return uuid;
  };

  const brief = (r: Rec, t0: number): unknown => {
    const m = r.m as unknown as Record<string, unknown>;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((b: Record<string, unknown>) =>
                b.type === 'text'
                  ? String(b.text)
                  : b.type === 'tool_use'
                    ? `tool_use:${String((b.input as { command?: string } | undefined)?.command ?? b.name)}`
                    : b.type === 'tool_result'
                      ? `tool_result:${clip(JSON.stringify(b.content), 100)}`
                      : String(b.type),
              )
              .join(' | ')
          : undefined;
    return {
      ms: r.at - t0,
      type: m.type,
      subtype: m.subtype,
      uuid: m.uuid,
      state: m.state,
      isReplay: m.isReplay,
      isSynthetic: m.isSynthetic,
      shouldQuery: m.shouldQuery,
      user_message_uuids: m.user_message_uuids,
      text: text === undefined ? undefined : clip(text, 160),
      extra:
        m.type === 'command_lifecycle' || m.type === 'result'
          ? clip(
              JSON.stringify(m, (k, v) =>
                k === 'usage' || k === 'modelUsage' || k === 'permission_denials' ? undefined : v,
              ),
              500,
            )
          : undefined,
    };
  };

  const results = (seen: Rec[]): number => seen.filter((r) => r.m.type === 'result').length;

  const assistantText = (seen: Rec[], from = 0): string =>
    seen
      .slice(from)
      .filter((r) => r.m.type === 'assistant')
      .map((r) => {
        const c = (r.m as unknown as { message?: { content?: unknown } }).message?.content;
        return Array.isArray(c)
          ? c
              .map((b: Record<string, unknown>) => (b.type === 'text' ? String(b.text) : ''))
              .join(' ')
          : '';
      })
      .join(' ');

  const finish = async (s: { session: AgentSession; ended: () => boolean }): Promise<void> => {
    s.session.close();
    await waitFor(s.ended, 15_000, 'the session to end').catch(() => {});
  };

  it('C3 shouldQuery false between turns', async () => {
    const s = startSession();
    const nonce = `nonce${randomUUID().slice(0, 8)}`;
    try {
      const t0 = Date.now();
      send(s.session, 'Reply with the word ok and nothing else. Do not use any tools.');
      await waitFor(() => results(s.seen) >= 1, 120_000, 'the first result');
      const mark = s.seen.length;
      const resultsBefore = results(s.seen);
      const uuids = bashEntry(`echo ${nonce}`, nonce).map((c) =>
        send(s.session, c, { shouldQuery: false }),
      );
      report('C3 appended uuids', uuids);
      await sleep(5_000);
      const during = s.seen.slice(mark);
      report(
        'C3 ECHOES (messages after the append, 5 s)',
        during.map((r) => brief(r, t0)),
      );
      // The brief expected no `result` at all; the CLI answers each such message with an empty
      // turn (init + result) and no assistant output, which the report records. What matters:
      // nothing was said by Claude.
      const resultsMid = results(s.seen);
      report('C3 results during the 5 s', resultsMid - resultsBefore);
      expect(
        during.filter((r) => r.m.type === 'assistant' || r.m.type === 'stream_event'),
      ).toHaveLength(0);
      const mark2 = s.seen.length;
      send(s.session, 'What did my last ! command print? Answer with that word only.');
      await waitFor(() => results(s.seen) > resultsMid, 120_000, 'the second result');
      const reply = assistantText(s.seen, mark2);
      report('C3 reply', { reply: clip(reply, 200), nonce });
      report(
        'C3 messages of the second turn',
        s.seen.slice(mark2).map((r) => brief(r, t0)),
      );
      report('C3 session id', s.sessionId);
      expect(reply).toContain(nonce);
      const lines = rawTranscript(s.sessionId).filter((l) => l.type === 'user');
      report(
        'C3 transcript user entries',
        lines.map((l) => shown(l, 200)),
      );
    } finally {
      await finish(s);
    }
  });

  it('C4 shouldQuery false mid-turn', async () => {
    const s = startSession();
    const nonce = `nonce${randomUUID().slice(0, 8)}`;
    try {
      const t0 = Date.now();
      send(
        s.session,
        'Use the Bash tool to run `sleep 8`. When it is done, reply with the word finished, then the output of any ! command I ran meanwhile (a <bash-stdout> block), or the word none.',
      );
      await waitFor(
        () =>
          s.seen.some((r) => {
            const c = (r.m as unknown as { message?: { content?: unknown } }).message?.content;
            return (
              r.m.type === 'assistant' &&
              Array.isArray(c) &&
              c.some((b: Record<string, unknown>) => b.type === 'tool_use')
            );
          }),
        120_000,
        'the Bash tool call',
      );
      await sleep(2_000);
      const mark = s.seen.length;
      bashEntry(`echo ${nonce}`, nonce).forEach((c) => send(s.session, c, { shouldQuery: false }));
      await waitFor(() => results(s.seen) >= 1, 120_000, 'the turn result');
      const turnText = assistantText(s.seen, mark);
      report(
        'C4 MID_TURN: messages after the append',
        s.seen.slice(mark).map((r) => brief(r, t0)),
      );
      report('C4 MID_TURN: the running turn mentions it', {
        mentionsNonce: turnText.includes(nonce),
        text: clip(turnText, 200),
      });
      const mark2 = s.seen.length;
      const before = results(s.seen);
      send(s.session, 'What did my last ! command print? Answer with that word only.');
      await waitFor(() => results(s.seen) > before, 120_000, 'the follow-up result');
      const reply = assistantText(s.seen, mark2);
      report('C4 MID_TURN: the next message gets it', {
        gotNonce: reply.includes(nonce),
        reply: clip(reply, 200),
      });
    } finally {
      await finish(s);
    }
  });

  const askShell = async (
    env: Record<string, string | undefined>,
  ): Promise<{ answers: string[]; tools: string[] }> => {
    const s = startSession({ env });
    try {
      send(
        s.session,
        'Use the Bash tool to run these two commands, one call each, and reply with only the word done: (1) echo "$0|$BASH_VERSION|$ZSH_VERSION|$SHELL" (2) echo $PATH',
      );
      await waitFor(() => results(s.seen) >= 1 || s.ended(), 120_000, 'the result');
      const answers: string[] = [];
      const tools: string[] = [];
      for (const r of s.seen) {
        const c = (r.m as unknown as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c as Record<string, unknown>[]) {
          if (b.type === 'tool_use') {
            tools.push(String((b.input as { command?: string }).command ?? b.name));
          }
          if (b.type === 'tool_result') {
            answers.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
          }
        }
      }
      return { answers, tools };
    } finally {
      await finish(s);
    }
  };

  const pathEntries = (value: string): string[] =>
    value.split(process.platform === 'win32' ? /[;:]/ : ':').filter(Boolean);

  it('C5 the shell Claude Code uses', async () => {
    const base = buildSessionEnv(cleanEnv(), null);
    const { answers, tools } = await askShell(base);
    report('C5 tools', tools);
    report(
      'C5 answers',
      answers.map((a) => clip(a, 700)),
    );
    const servicePath = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
    const claudePathText = answers.reduce((a, b) => (b.length > a.length ? b : a), '');
    const seen = pathEntries(claudePathText);
    report('C5 PATH compare', {
      serviceEntries: servicePath.length,
      claudeEntries: seen.length,
      claudeStartsWith: seen.slice(0, 6),
      shell: process.env.SHELL,
    });
    expect(answers.length).toBeGreaterThan(0);

    if (process.platform === 'win32') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      if (existsSync(gitBash)) {
        const copy = path.join(mkdtempSync(path.join(os.tmpdir(), 'tg-bash-copy-')), 'bash.exe');
        copyFileSync(gitBash, copy);
        const withCopy = await askShell({ ...base, CLAUDE_CODE_GIT_BASH_PATH: copy });
        report('C5 win32 with CLAUDE_CODE_GIT_BASH_PATH=copy', {
          copy,
          tools: withCopy.tools,
          answers: withCopy.answers.map((a) => clip(a, 300)),
        });
        const withReal = await askShell({ ...base, CLAUDE_CODE_GIT_BASH_PATH: gitBash });
        report('C5 win32 with CLAUDE_CODE_GIT_BASH_PATH=Git', {
          answers: withReal.answers.map((a) => clip(a, 200)),
        });
        rmSync(path.dirname(copy), { recursive: true, force: true });
      }
    }
  });
});
