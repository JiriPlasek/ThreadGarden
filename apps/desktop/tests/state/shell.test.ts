import type { ChatSummary, ShellRun } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { ChatsState } from '../../src/lib/state/chats.svelte';
import { ShellOutput } from '../../src/lib/state/shell-output';
import { FakeServer } from '../service/fake-ws';

const summary = (sessionId: string): ChatSummary => ({
  sessionId,
  title: sessionId,
  projectId: 'p',
  cwd: '/w',
  status: 'idle',
  preview: '',
  lastActivity: 0,
  pinned: false,
  live: true,
  external: null,
  unread: false,
  bucket: 'active',
  backFromHold: false,
});
const run = (over: Partial<ShellRun> = {}): ShellRun => ({
  runId: 'r1',
  sessionId: 's1',
  command: 'ls',
  cwd: '/w',
  cols: 100,
  rows: 24,
  startedAt: 1000,
  state: 'running',
  ...over,
});

let server: FakeServer;
let client: ServiceClient;
const flushAsync = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  client = new ServiceClient({ WebSocketImpl: server.Impl });
  const p = client.connect('ws://x:1', 't');
  await flushAsync();
  await p;
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe('ShellOutput', () => {
  it('ShellOutput keeps the end and drops repeats', () => {
    const out = new ShellOutput(10);
    const seen: string[] = [];
    out.listen((d) => seen.push(d));
    expect(out.push(0, 'abcdef')).toBe('ok');
    // Overlaps the first chunk by three characters: only 'ghi' is new.
    expect(out.push(3, 'defghi')).toBe('ok');
    // Ends before `end`: dropped.
    expect(out.push(0, 'abc')).toBe('ok');
    expect(out.text()).toBe('abcdefghi');
    expect(out.end).toBe(9);
    expect(seen).toEqual(['abcdef', 'ghi']);
    out.push(9, 'jklmn');
    expect(out.text()).toBe('efghijklmn');
    expect(out.text().length).toBeLessThanOrEqual(10);
    expect(out.end).toBe(14);
  });

  it('reset redraws for listeners and continues from its offset', () => {
    const out = new ShellOutput();
    const seen: [string, boolean | undefined][] = [];
    out.listen((d, reset) => seen.push([d, reset]));
    out.reset('xyz', 100);
    expect(out.end).toBe(103);
    expect(out.push(103, 'w')).toBe('ok');
    expect(seen).toEqual([
      ['xyz', true],
      ['w', undefined],
    ]);
  });
});

describe('a chat’s command', () => {
  const setup = async (open: Record<string, unknown> = {}) => {
    const chats = new ChatsState();
    chats.init(client, { schedule: (cb) => cb() });
    server.handlers['chat.open'] = (p) => ({
      summary: summary((p as { sessionId: string }).sessionId),
      header: {},
      items: [],
      hasMore: false,
      seq: 10,
      tasks: [],
      ...open,
    });
    await chats.open('s1');
    return chats;
  };

  it('a gap asks for shell.get once', async () => {
    const chats = await setup();
    server.push('shell.run', run());
    await flushAsync();
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 0, data: 'ab' });
    server.handlers['shell.get'] = () => ({
      view: { run: run(), output: 'abcdefgh', offset: 0 },
    });
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 5, data: 'fg' });
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 7, data: 'h' });
    await flushAsync();
    expect(server.calls('shell.get')).toHaveLength(1);
    expect(chats.get('s1')!.shellOutput.text()).toBe('abcdefgh');
  });

  it('shell.run sets the chat’s run and counts it as running until it ends', async () => {
    const chats = await setup();
    const chat = chats.get('s1')!;
    expect(chat.running).toBe(0);
    server.push('shell.run', run());
    await flushAsync();
    expect(chat.shell?.runId).toBe('r1');
    expect(chat.running).toBe(1);
    server.push(
      'shell.run',
      run({ state: 'ended', exitCode: 0, endReason: 'exit', endedAt: 2000 }),
    );
    await flushAsync();
    expect(chat.shell?.state).toBe('ended');
    expect(chat.running).toBe(0);
    // A new run replaces the old one and its output.
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 0, data: 'old' });
    server.push('shell.run', run({ runId: 'r2', startedAt: 3000 }));
    await flushAsync();
    expect(chat.shell?.runId).toBe('r2');
    expect(chat.shellOutput.text()).toBe('');
    expect(chat.running).toBe(1);
  });

  it('chat.open’s shell fills the output', async () => {
    const chats = await setup({ shell: { run: run(), output: 'hello', offset: 40 } });
    const chat = chats.get('s1')!;
    expect(chat.shell?.runId).toBe('r1');
    expect(chat.shellOutput.text()).toBe('hello');
    expect(chat.shellOutput.end).toBe(45);
    expect(chat.running).toBe(1);
  });

  it('resync reloads a running command’s output', async () => {
    const chats = await setup({ shell: { run: run(), output: 'hel', offset: 0 } });
    const chat = chats.get('s1')!;
    server.handlers['chat.since'] = () => ({ events: [], seq: 10 });
    server.handlers['shell.get'] = () => ({
      view: { run: run(), output: 'hello wor', offset: 0 },
    });
    await chats.resync();
    expect(chat.shellOutput.text()).toBe('hello wor');
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 9, data: 'ld' });
    await flushAsync();
    expect(chat.shellOutput.text()).toBe('hello world');
    expect(server.calls('shell.get')).toHaveLength(1);
  });

  it('events of other chats and old runs are ignored', async () => {
    const chats = await setup();
    const chat = chats.get('s1')!;
    server.push('shell.run', run({ runId: 'r2', startedAt: 3000 }));
    server.push('shell.run', run({ runId: 'r1', startedAt: 1000 }));
    server.push('shell.run', run({ runId: 'x', sessionId: 'other' }));
    server.push('shell.output', { runId: 'r1', sessionId: 's1', offset: 0, data: 'old' });
    server.push('shell.output', { runId: 'r2', sessionId: 'other', offset: 0, data: 'else' });
    await flushAsync();
    expect(chat.shell?.runId).toBe('r2');
    expect(chat.shellOutput.text()).toBe('');
    expect(chats.get('other')).toBeUndefined();
    expect(server.calls('shell.get')).toHaveLength(0);
  });

  it('the four actions call the service and startCommand shows the run', async () => {
    const chats = await setup();
    server.handlers['shell.start'] = () => run({ runId: 'r9', startedAt: 5000 });
    server.handlers['shell.input'] = () => ({});
    server.handlers['shell.resize'] = () => ({});
    server.handlers['shell.stop'] = () => ({});
    const started = await chats.startCommand('s1', 'ls', { cols: 80, rows: 20 });
    expect(started.runId).toBe('r9');
    expect(chats.get('s1')!.shell?.runId).toBe('r9');
    await chats.commandInput('r9', 'pw\r');
    await chats.commandResize('r9', { cols: 90, rows: 30 });
    await chats.commandStop('r9');
    expect(server.calls('shell.start')[0]!.params).toEqual({
      sessionId: 's1',
      command: 'ls',
      cols: 80,
      rows: 20,
    });
    expect(server.calls('shell.input')[0]!.params).toEqual({ runId: 'r9', data: 'pw\r' });
    expect(server.calls('shell.resize')[0]!.params).toEqual({ runId: 'r9', cols: 90, rows: 30 });
    expect(server.calls('shell.stop')[0]!.params).toEqual({ runId: 'r9' });
  });
});
