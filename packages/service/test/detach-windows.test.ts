import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.skipIf(process.platform !== 'win32')(
  'Windows targets survive the launching Node process and retain their arguments',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tg detach ' space "));
    try {
      const marker = path.join(root, 'result.json');
      const target = path.join(root, 'target.cjs');
      await writeFile(
        target,
        `setTimeout(() => require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, args: process.argv.slice(3) })), 1000);`,
      );
      const args = [
        '',
        'space here',
        "apostrophe'",
        'embedded"quote',
        'C:\\trailing space\\',
        '$() ; & Unicode \u017e',
      ];
      const helper = pathToFileURL(path.resolve('src/detach.ts')).href;
      const parent = `import { startDetached } from ${JSON.stringify(helper)}; console.log(await startDetached(${JSON.stringify(process.execPath)}, ${JSON.stringify([target, marker, ...args])}));`;
      const { stdout } = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', parent],
        { timeout: 15000, windowsHide: true },
      );
      const pid = Number(stdout.trim());
      expect(pid).toBeGreaterThan(0);
      await expect
        .poll(async () => JSON.parse(await readFile(marker, 'utf8')), { timeout: 10000 })
        .toEqual({ pid, args });

      // Exercise the updater's actual target, not just node.exe.
      const script = path.join(root, 'apply.ps1');
      const psMarker = path.join(root, 'powershell.txt');
      await writeFile(
        script,
        'param([string]$marker)\nStart-Sleep -Seconds 1\n[IO.File]::WriteAllText($marker, [string]$PID)',
      );
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const psParent = `import { startDetached } from ${JSON.stringify(helper)}; console.log(await startDetached(${JSON.stringify(powershell)}, ${JSON.stringify(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, psMarker])}));`;
      const result = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', psParent],
        { timeout: 15000, windowsHide: true },
      );
      await expect
        .poll(() => readFile(psMarker, 'utf8'), { timeout: 10000 })
        .toBe(result.stdout.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
