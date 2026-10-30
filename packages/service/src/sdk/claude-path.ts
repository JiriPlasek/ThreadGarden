/**
 * Finds the user's installed `claude` (§6.4): the path from pahub settings,
 * then `PATH`, then the standard install locations. There is deliberately no
 * fallback to the SDK's bundled binary. Every candidate must answer
 * `claude --version` to count as found.
 *
 * The result goes to the SDK as `pathToClaudeCodeExecutable`. The SDK runs a
 * `.js`/`.mjs` path with `node` and spawns anything else directly, without a
 * shell. On Windows that rules out `.cmd`/`.bat` launchers (npm installs), so
 * a launcher is resolved to the file it starts (`cli.js` or a native `.exe`),
 * and `.exe` candidates are preferred everywhere.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type FindClaudeOptions = {
  /** `claudePath` from pahub settings, or null when unset. */
  settingPath: string | null;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** True when `p` is an existing file. */
  exists(p: string): boolean;
  /** Runs `cmd args…` and resolves with its stdout; rejects when it cannot run or fails. */
  run(cmd: string, args: string[]): Promise<string>;
  /** Reads a Windows `.cmd` launcher's text to find what it starts; without it launchers are unrunnable. */
  readFile?(p: string): string;
};

export type ClaudeFound = { path: string; version: string };
export type ClaudeProblem = { problem: 'missing' | 'unrunnable'; detail: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Paths the SDK runs through `node` rather than spawning them. */
const isScript = (p: string): boolean => /\.(js|mjs)$/i.test(p);
const isLauncher = (p: string): boolean => /\.(cmd|bat)$/i.test(p);
/** What Windows can spawn without a shell, plus scripts the SDK runs with `node`. */
const spawnableOnWindows = (p: string): boolean => /\.(exe|com)$/i.test(p) || isScript(p);

/** `PATH` lookup; Windows environment names are case-insensitive (usually `Path`). */
const pathValue = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key && env[key]) || '';
};

/**
 * Candidate paths in priority order, without duplicates: the settings path,
 * then (on Windows every `.exe` before any `.cmd`) `PATH`, `~/.local/bin`,
 * `~/.claude/local`.
 */
export const claudeCandidates = (
  o: Pick<FindClaudeOptions, 'settingPath' | 'env' | 'platform' | 'home'>,
): string[] => {
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = pathValue(o.env, o.platform)
    .split(p.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d);
  // On Windows an extensionless `claude` on PATH is npm's sh shim, which cannot be spawned.
  const binary = win ? 'claude.exe' : 'claude';
  const list: string[] = [];
  if (o.settingPath) list.push(o.settingPath);
  for (const d of dirs) list.push(p.join(d, binary));
  list.push(p.join(o.home, '.local', 'bin', binary));
  list.push(p.join(o.home, '.claude', 'local', binary));
  if (win) for (const d of dirs) list.push(p.join(d, 'claude.cmd'));
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = win ? c.toLowerCase() : c;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The file a Windows `.cmd` launcher (npm / pnpm / yarn `cmd-shim`) starts:
 * the last quoted `%dp0%` / `%~dp0` path in it that is not `node.exe`.
 */
export const launcherTarget = (launcher: string, text: string): string | undefined => {
  const dir = path.win32.dirname(launcher);
  const targets = [...text.matchAll(/"([^"]*%~?dp0%?[^"]*)"/gi)]
    .map((m) => m[1]!)
    .filter((s) => !s.includes('='))
    .map((s) => path.win32.normalize(s.replace(/%~?dp0%?/gi, `${dir}\\`)))
    .filter((s) => !/(^|\\)node\.exe$/i.test(s));
  return targets.at(-1);
};

const launcherProblem = (launcher: string, why: string): string =>
  `${launcher} is a .cmd launcher, which the Claude Agent SDK cannot start (it runs the ` +
  `executable directly, without a shell), and ${why}. Install the native Claude Code build ` +
  `(claude.exe), or set pahub's Claude path to claude.exe or to Claude Code's cli.js.`;

/** The path to hand the SDK for `candidate`, or why it cannot be launched. */
const launchTarget = (candidate: string, o: FindClaudeOptions): string | { problem: string } => {
  if (o.platform !== 'win32' || !isLauncher(candidate)) return candidate;
  let text: string;
  try {
    if (!o.readFile) return { problem: launcherProblem(candidate, 'it could not be read') };
    text = o.readFile(candidate);
  } catch (err) {
    return { problem: launcherProblem(candidate, `it could not be read (${errorText(err)})`) };
  }
  const target = launcherTarget(candidate, text);
  if (target === undefined) {
    return { problem: launcherProblem(candidate, 'the program it starts could not be determined') };
  }
  if (!spawnableOnWindows(target)) {
    return { problem: launcherProblem(candidate, `the program it starts (${target}) is not one`) };
  }
  if (!o.exists(target)) {
    return { problem: launcherProblem(candidate, `the program it starts (${target}) is missing`) };
  }
  return target;
};

/** `2.1.314 (Claude Code)` → `2.1.314`; anything else → its first non-empty line. */
export const parseClaudeVersion = (stdout: string): string => {
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(stdout);
  if (m) return m[0];
  return (
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l) ?? ''
  );
};

export const findClaude = async (o: FindClaudeOptions): Promise<ClaudeFound | ClaudeProblem> => {
  let firstFailure: string | undefined;
  for (const candidate of claudeCandidates(o)) {
    if (!o.exists(candidate)) continue;
    const target = launchTarget(candidate, o);
    if (typeof target !== 'string') {
      firstFailure ??= target.problem;
      continue;
    }
    try {
      // Run the version check the way the SDK will start it: a script with
      // this process's own Node (the bundled sidecar in release builds), never
      // a `node` from PATH, which a macOS GUI launch may not have.
      const out = isScript(target)
        ? await o.run(process.execPath, [target, '--version'])
        : await o.run(target, ['--version']);
      return { path: target, version: parseClaudeVersion(out) };
    } catch (err) {
      firstFailure ??= `Claude Code was found but did not run (${target}: ${errorText(err)})`;
    }
  }
  if (firstFailure !== undefined) return { problem: 'unrunnable', detail: firstFailure };
  const configured = o.settingPath ? ` The configured path ${o.settingPath} does not exist.` : '';
  return {
    problem: 'missing',
    detail: `Claude Code was not found on PATH or in the standard install locations.${configured}`,
  };
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Per candidate; a hung `claude --version` must not stall locating for long (candidates run in turn). */
const VERSION_TIMEOUT_MS = 5_000;

const runCommand = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/** `findClaude` against the real machine. */
export const findInstalledClaude = (
  settingPath: string | null,
): Promise<ClaudeFound | ClaudeProblem> =>
  findClaude({
    settingPath,
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    exists: isFile,
    run: runCommand,
    readFile: (p) => readFileSync(p, 'utf8'),
  });
