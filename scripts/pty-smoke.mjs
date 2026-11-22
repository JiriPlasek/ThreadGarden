#!/usr/bin/env node
/**
 * Checks that the PTY package loads and runs a command on this machine:
 *
 *   node scripts/pty-smoke.mjs <dir holding node_modules>
 *
 * Imports `@lydell/node-pty` from `<dir>/node_modules` (the way the service
 * bundle finds it next to `service.mjs`), runs `echo tg-pty-$((40+2))` through
 * the platform's shell in a pseudo-terminal, and exits 0 only when the output
 * holds `tg-pty-42` and the command exited 0. Prints
 * `[pty-smoke] ok <platform>-<arch> node <version>` on success. Run it with
 * the Node that will run the service (the `threadgarden-node` sidecar).
 */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/pty-smoke.mjs <dir holding node_modules>');
  process.exit(2);
}

const fail = (message) => {
  console.error(
    `[pty-smoke] FAIL ${process.platform}-${process.arch} node ${process.version}: ${message}`,
  );
  process.exit(1);
};

/** The shell line for this platform: bash where there is one, else PowerShell on Windows. */
const shellLine = () => {
  const command = 'echo tg-pty-$((40+2))';
  if (process.platform !== 'win32') return { file: 'bash', args: ['-c', command] };
  let bash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (!bash || !existsSync(bash)) {
    bash = undefined;
    const found = spawnSync('where', ['git'], { encoding: 'utf8' });
    for (const line of (found.stdout ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      // <git root>\cmd\git.exe or <git root>\mingw64\bin\git.exe -> <git root>\bin\bash.exe
      const root = resolve(line.trim(), '..', '..');
      for (const candidate of [
        join(root, 'bin', 'bash.exe'),
        join(root, '..', 'bin', 'bash.exe'),
      ]) {
        if (existsSync(candidate)) {
          bash = candidate;
          break;
        }
      }
      if (bash) break;
    }
  }
  if (bash) return { file: bash, args: ['-c', command] };
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded],
  };
};

let pty;
try {
  pty = createRequire(join(resolve(dir), 'noop.js'))('@lydell/node-pty');
} catch (err) {
  fail(`cannot load @lydell/node-pty from ${dir}: ${err instanceof Error ? err.message : err}`);
}

const { file, args } = shellLine();
let output = '';
const term = pty.spawn(file, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.cwd(),
  env: process.env,
});
term.onData((d) => {
  output += d;
});
const timer = setTimeout(() => {
  try {
    term.kill();
  } catch {
    // already gone
  }
  fail(`timed out; output so far: ${JSON.stringify(output)}`);
}, 20_000);
term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) fail(`exit code ${exitCode}; output: ${JSON.stringify(output)}`);
  if (!output.includes('tg-pty-42')) fail(`output lacks tg-pty-42: ${JSON.stringify(output)}`);
  console.log(`[pty-smoke] ok ${process.platform}-${process.arch} node ${process.version}`);
  process.exit(0);
});
