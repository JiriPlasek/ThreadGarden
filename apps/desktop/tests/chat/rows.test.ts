import { describe, expect, it } from 'vitest';
import { buildRows } from '../../src/lib/components/chat/rows';
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
