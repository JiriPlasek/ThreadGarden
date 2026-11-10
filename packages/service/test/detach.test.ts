import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: { cmd: string; args: string[]; opts: unknown; child: FakeChild }[] = [];

class FakeChild extends EventEmitter {
  pid = 4242;
  unrefed = false;
  unref() {
    this.unrefed = true;
  }
}

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    const child = new FakeChild();
    spawned.push({ cmd, args, opts, child });
    return child;
  },
}));

const { startDetached } = await import('../src/detach.js');

describe('startDetached', () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it('starts the command on its own, hidden, with stdio ignored, and answers its pid', async () => {
    const started = startDetached('C:\\tg\\node\\node.exe', ['service.mjs', 'serve']);
    spawned[0]!.child.emit('spawn');
    expect(await started).toBe(4242);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      cmd: 'C:\\tg\\node\\node.exe',
      args: ['service.mjs', 'serve'],
      opts: { detached: true, stdio: 'ignore', windowsHide: true },
    });
    expect(spawned[0]!.child.unrefed).toBe(true);
  });

  it('rejects when the command cannot be started', async () => {
    const started = startDetached('missing.exe', []);
    spawned[0]!.child.emit('error', new Error('spawn missing.exe ENOENT'));
    await expect(started).rejects.toThrow('spawn missing.exe ENOENT');
  });
});
