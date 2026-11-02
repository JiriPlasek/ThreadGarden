import type { RunResult, Tools } from '../../src/projects/github.js';

export type Matcher = string | RegExp | ((args: string[]) => boolean);
export type Reply = { cmd: 'gh' | 'git'; match: Matcher; result: Partial<RunResult> };
export type Call = { cmd: 'gh' | 'git'; args: string[]; cwd?: string; timeoutMs?: number };

export type FakeSpawn = {
  call: Call;
  /** Finishes the fake clone with this result. */
  finish(result?: Partial<RunResult>): void;
  cancelled: boolean;
};

const matches = (m: Matcher, args: string[]): boolean => {
  const line = args.join(' ');
  if (typeof m === 'string') return line.startsWith(m);
  if (m instanceof RegExp) return m.test(line);
  return m(args);
};

const full = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  ...r,
});

/** A `Tools` that records every call and replays the first reply whose command and args match. */
export const fakeTools = (
  replies: Reply[] = [],
): Tools & { calls: Call[]; spawned: FakeSpawn[]; replies: Reply[] } => {
  const calls: Call[] = [];
  const spawned: FakeSpawn[] = [];
  return {
    calls,
    spawned,
    replies,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      const r = replies.find((x) => x.cmd === cmd && matches(x.match, args));
      return r
        ? full(r.result)
        : { code: 1, stdout: '', stderr: `unexpected: ${cmd} ${args.join(' ')}` };
    },
    spawn: (cmd, args, opts) => {
      const call: Call = { cmd, args, cwd: opts.cwd };
      calls.push(call);
      let resolveDone!: (r: RunResult) => void;
      const done = new Promise<RunResult>((res) => (resolveDone = res));
      const s: FakeSpawn = {
        call,
        cancelled: false,
        finish: (result = {}) => resolveDone(full(result)),
      };
      spawned.push(s);
      return {
        done,
        cancel: () => {
          s.cancelled = true;
          resolveDone({ code: -1, stdout: '', stderr: 'cancelled' });
        },
      };
    },
  };
};
