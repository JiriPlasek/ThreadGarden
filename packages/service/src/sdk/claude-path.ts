/**
 * Finds the user's installed `claude` (§6.4): the path from pahub settings,
 * then `PATH`, then the standard install locations. There is deliberately no
 * fallback to the SDK's bundled binary. Every candidate must answer
 * `claude --version` to count as found.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
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
};

export type ClaudeFound = { path: string; version: string };
export type ClaudeProblem = { problem: 'missing' | 'unrunnable'; detail: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `PATH` lookup; Windows environment names are case-insensitive (usually `Path`). */
const pathValue = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key && env[key]) || '';
};

/** Candidate paths in priority order, without duplicates. */
export const claudeCandidates = (o: Omit<FindClaudeOptions, 'exists' | 'run'>): string[] => {
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  // On Windows an extensionless `claude` on PATH is npm's sh shim, which cannot be spawned.
  const pathNames = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const binary = win ? 'claude.exe' : 'claude';
  const list: string[] = [];
  if (o.settingPath) list.push(o.settingPath);
  for (const dir of pathValue(o.env, o.platform).split(p.delimiter)) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d) for (const name of pathNames) list.push(p.join(d, name));
  }
  list.push(p.join(o.home, '.local', 'bin', binary));
  list.push(p.join(o.home, '.claude', 'local', binary));
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = win ? c.toLowerCase() : c;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    try {
      const out = await o.run(candidate, ['--version']);
      return { path: candidate, version: parseClaudeVersion(out) };
    } catch (err) {
      firstFailure ??= `${candidate}: ${errorText(err)}`;
    }
  }
  if (firstFailure !== undefined) {
    return {
      problem: 'unrunnable',
      detail: `Claude Code was found but did not run (${firstFailure})`,
    };
  }
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

/** Runs a candidate's `--version`. Windows `.cmd`/`.bat` shims need a shell (Node refuses them otherwise). */
const runVersion = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const file = shim ? `"${cmd}"` : cmd;
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, shell: shim, encoding: 'utf8' },
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
    run: runVersion,
  });
