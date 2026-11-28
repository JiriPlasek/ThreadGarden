import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
const spawned: { cmd: string; args: string[]; opts: unknown; child: FakeChild }[] = [];
class FakeChild extends EventEmitter {
  pid = 4242;
  unref = vi.fn();
}
vi.mock('node:child_process', () => ({
  execFile,
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
    execFile.mockReset();
    vi.stubGlobal('process', { ...process, platform: 'linux' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts Unix commands independently and answers their pid', async () => {
    const started = startDetached('/usr/bin/node', ['service.mjs', 'serve']);
    spawned[0]!.child.emit('spawn');
    expect(await started).toBe(4242);
    expect(spawned[0]).toMatchObject({
      cmd: '/usr/bin/node',
      args: ['service.mjs', 'serve'],
      opts: { detached: true, stdio: 'ignore', windowsHide: true },
    });
    expect(spawned[0]!.child.unref).toHaveBeenCalled();
  });

  it('rejects when a Unix command cannot be started', async () => {
    const started = startDetached('missing', []);
    spawned[0]!.child.emit('error', new Error('ENOENT'));
    await expect(started).rejects.toThrow('ENOENT');
  });

  it('uses a normal Windows launcher and returns the independent target pid', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const started = startDetached('C:\\tg\\powershell.exe', ['-File', 'apply.ps1']);
    expect(spawned).toHaveLength(0);
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/powershell.exe$/),
      expect.arrayContaining(['-EncodedCommand', expect.any(String)]),
      expect.objectContaining({ windowsHide: true, timeout: 30000 }),
      expect.any(Function),
    );
    execFile.mock.calls[0]![3](null, '1234\r\n', '');
    expect(await started).toBe(1234);
  });

  it.each(['0', '', 'garbage'])('rejects an invalid Windows pid: %j', async (stdout) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const started = startDetached('missing.exe', []);
    execFile.mock.calls[0]![3](null, stdout, '');
    await expect(started).rejects.toThrow();
  });

  it('reports a Windows launcher failure', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const started = startDetached('missing.exe', []);
    execFile.mock.calls[0]![3](new Error('Start-Process failed'), '', '');
    await expect(started).rejects.toThrow('Start-Process failed');
  });
});
