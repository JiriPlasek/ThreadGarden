import type { ChatItem, ShellRun } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import { buildRows, quietTail, withShell } from '../../src/lib/components/chat/rows';
import { text, tool, unknownItem, user } from './fixtures';

describe('buildRows', () => {
  it('collapses consecutive unknown items into one row (R12)', () => {
    const rows = buildRows([
      user('u1'),
      unknownItem('x1'),
      unknownItem('x2'),
      unknownItem('x3'),
      text('a1'),
      unknownItem('x4'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['item', 'unknownGroup', 'item', 'item']);
    const group = rows[1]!;
    expect(group.kind === 'unknownGroup' && group.items.map((i) => i.id)).toEqual([
      'x1',
      'x2',
      'x3',
    ]);
    // A lone unknown item stays a plain row.
    expect(rows[3]!.kind === 'item' && rows[3]!.item.id).toBe('x4');
  });

  it('nests items under the Agent/Task call that started them', () => {
    const agent = tool('t1', 'Agent', { description: 'Explore' }, { toolUseId: 'tu-agent' });
    const rows = buildRows([
      user('u1'),
      agent,
      text('c1', 'child', { parentToolUseId: 'tu-agent' }),
      tool('c2', 'Read', { file_path: '/a' }, { parentToolUseId: 'tu-agent' }),
      text('a2'),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['u1', 't1', 'a2']);
    const row = rows[1]!;
    expect(row.kind === 'item' && row.children?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('keeps items whose parent call is not loaded at the top level', () => {
    const rows = buildRows([text('c1', 'orphan', { parentToolUseId: 'tu-missing' })]);
    expect(rows.map((r) => r.key)).toEqual(['c1']);
  });

  it('groups consecutive same-tool reads into one row', () => {
    const rows = buildRows([
      tool('r1', 'Read', { file_path: '/a' }),
      tool('r2', 'Read', { file_path: '/b' }),
      tool('r3', 'Read', { file_path: '/c' }),
      tool('b1', 'Bash', { command: 'ls' }),
      tool('b2', 'Bash', { command: 'pwd' }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['toolGroup', 'item', 'item']);
    const g = rows[0]!;
    expect(g.kind === 'toolGroup' && g.items.length).toBe(3);
    expect(g.key).toBe('group:r1');
  });

  it('maps every item id to its row', () => {
    const rows = buildRows([unknownItem('x1'), unknownItem('x2'), user('u1')]);
    expect(rows.flatMap((r) => r.itemIds)).toEqual(['x1', 'x2', 'u1']);
  });
});

describe('quietTail', () => {
  it('is quiet right after the user’s message', () => {
    expect(quietTail([text('a0'), user('u1')])).toBe(true);
  });

  it('is quiet when the last turn’s output has all finished', () => {
    expect(quietTail([user('u1'), tool('b1', 'Bash', { command: 'ls' }), text('a1')])).toBe(true);
  });

  it('is not quiet while text streams or a tool call runs', () => {
    expect(quietTail([user('u1'), text('a1', 'Hel', { streaming: true })])).toBe(false);
    expect(
      quietTail([user('u1'), tool('b1', 'Bash', { command: 'ls' }, { status: 'running' })]),
    ).toBe(false);
  });

  it('is not quiet while a request waits for the user', () => {
    const request: ChatItem = {
      kind: 'permissionRequest',
      id: 'p1',
      requestId: 'r1',
      toolName: 'Bash',
      input: {},
      suggestions: [],
      state: 'pending',
      variant: 'tool',
    };
    expect(quietTail([user('u1'), request])).toBe(false);
  });

  it('ignores a call left running before the latest message', () => {
    expect(
      quietTail([tool('b1', 'Bash', { command: 'ls' }, { status: 'running' }), user('u2')]),
    ).toBe(true);
  });

  it('ignores a subagent’s own output, which its row already shows', () => {
    const agent = tool('t1', 'Agent', { description: 'Explore' }, { toolUseId: 'tu-agent' });
    expect(
      quietTail([
        user('u1'),
        agent,
        text('c1', 'child', { parentToolUseId: 'tu-agent', streaming: true }),
      ]),
    ).toBe(true);
  });
});

describe('withShell', () => {
  const run = (over: Partial<ShellRun> = {}): ShellRun => ({
    runId: 'r1',
    sessionId: 's1',
    command: 'ls',
    cwd: '/home/me',
    cols: 100,
    rows: 24,
    startedAt: 1,
    state: 'running',
    ...over,
  });
  const ids = (items: ChatItem[]) => items.map((i) => i.id);
  const kinds = (rows: ReturnType<typeof withShell>) =>
    rows.map((r) => (r.kind === 'item' ? r.item.id : r.kind));

  it("a running command's block comes last", () => {
    const items = [user('u1'), text('a1')];
    const rows = withShell(buildRows(items), run(), ids(items));
    expect(kinds(rows)).toEqual(['u1', 'a1', 'shell']);
  });

  it("an appended run's block follows its ! line and hides the output entry", () => {
    // As appended: two entries, each with its own id; the output is an info line.
    const output: ChatItem = { kind: 'system', id: 'e2', level: 'info', text: 'a.txt' };
    const items = [user('u1'), user('e1', '<bash-input>ls</bash-input>'), output, text('a1')];
    const rows = withShell(
      buildRows(items),
      run({ state: 'ended', entryId: 'e1', outputId: 'e2' }),
      ids(items),
    );
    expect(kinds(rows)).toEqual(['u1', 'e1', 'shell', 'a1']);
  });

  it('without an outputId, the output line is the one-entry `<entryId>:out`', () => {
    const items = [user('e1', '<bash-input>ls</bash-input>'), user('e1:out'), text('a1')];
    const rows = withShell(buildRows(items), run({ state: 'ended', entryId: 'e1' }), ids(items));
    expect(kinds(rows)).toEqual(['e1', 'shell', 'a1']);
  });

  it('an ended run that was not appended stays last', () => {
    const items = [user('u1')];
    const rows = withShell(
      buildRows(items),
      run({ state: 'ended', endReason: 'session' }),
      ids(items),
    );
    expect(kinds(rows)).toEqual(['u1', 'shell']);
  });

  it('without a run, a ! line and its output render as plain rows', () => {
    const rows = buildRows([user('e1', '<bash-input>ls</bash-input>'), user('e1:out')]);
    expect(kinds(rows)).toEqual(['e1', 'e1:out']);
  });
});
