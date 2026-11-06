import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { endProcessTree } from '../../src/external/end-process.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (ok: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('endProcessTree', () => {
  it('ends a running process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    await endProcessTree(child.pid!);
    await exited;
    expect(alive(child.pid!)).toBe(false);
  });

  // Windows does not end a process's children with it; the tree must go too
  // (a claude process's tool shells and MCP servers).
  it.runIf(process.platform === 'win32')('ends the processes it started, on Windows', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(g.pid);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const [line] = (await once(child.stdout!, 'data')) as [Buffer];
    const grandchild = Number(line.toString().trim());
    expect(alive(grandchild)).toBe(true);
    await endProcessTree(child.pid!);
    await waitUntil(() => !alive(grandchild));
  });

  it('refuses pids that would signal a process group or every process', async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await expect(endProcessTree(pid)).rejects.toThrow(/pid/);
    }
  });
});
