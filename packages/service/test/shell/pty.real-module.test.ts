import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EventMsg } from '@threadgarden/protocol';
import { loadPty } from '../../src/shell/pty.js';
import { PtyRun, type ShellRunEnd } from '../../src/shell/run.js';
import { shellLine } from '../../src/shell/shell-line.js';

const factory = await loadPty({ warn: () => {} });

const which = (name: string): string | undefined => {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return found.stdout
    ?.split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
};

describe.skipIf(!factory)('the real PTY module', () => {
  it('runs a real command in a PTY', async () => {
    const events: EventMsg[] = [];
    const end = await new Promise<ShellRunEnd>((resolve) => {
      new PtyRun(
        {
          runId: 'r',
          sessionId: 's',
          command: 'echo tg-$((1+1))',
          cwd: process.cwd(),
          cols: 100,
          rows: 24,
          env: process.env,
        },
        {
          pty: factory!,
          line: (c) =>
            shellLine(c, {
              platform: process.platform,
              env: process.env,
              which,
              exists: existsSync,
            }),
          emit: (e) => events.push(e),
          now: Date.now,
          timers: {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
            setInterval: (fn, ms) => setInterval(fn, ms),
            clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
          },
          onEnd: resolve,
        },
      );
    });
    expect(end.exitCode).toBe(0);
    expect(end.transcript).toContain('tg-2');
    const shown = events
      .filter((e) => e.event === 'shell.output')
      .map((e) => (e.data as { data: string }).data)
      .join('');
    expect(shown).toContain('tg-2');
  }, 20_000);
});
