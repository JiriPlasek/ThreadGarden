import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  MOVE_CAPABILITY,
  MOVE_ERRORS,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  acceptsRemoteProtocol,
  methods,
} from '../src/index.js';

const peer = { machineId: 'm', name: 'kumbal-machine' };
const entry = { type: 'user', uuid: 'u', anything: { nested: [1, 2] } };

describe('protocol 9', () => {
  it('is protocol 10 and accepts remotes at 9 to 11', () => {
    expect(PROTOCOL_VERSION).toBe(10);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 9, max: 11 });
    expect([8, 9, 10, 11, 12].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
  });

  it('has the move capability and error codes', () => {
    expect(MOVE_CAPABILITY).toBe('move');
    expect(CAPABILITIES).toContain('move');
    expect(MOVE_ERRORS.moving).toBe('MOVING');
    expect(MOVE_ERRORS.expired).toBe('EXPIRED');
    expect(MOVE_ERRORS.already).toBe('ALREADY_HERE');
  });

  it('a chat running in a terminal is busy', () => {
    const r = methods['move.check'].result;
    const git = { kind: 'notRepo' };
    expect(r.safeParse({ cwd: '/x', busy: 'terminal', git }).success).toBe(true);
  });

  it('move.markMoved names the chat and when its move began', () => {
    const p = methods['move.markMoved'].params;
    expect(p.safeParse({ exportId: 'e', to: peer }).success).toBe(false);
    expect(p.parse({ exportId: 'e', sessionId: 's', begunAt: 5, to: peer }).begunAt).toBe(5);
  });
});

describe('move methods', () => {
  const cases: Record<string, { params: Record<string, unknown>; result: unknown }> = {
    'move.check': {
      params: { sessionId: 's' },
      result: {
        cwd: '/x',
        busy: null,
        git: { kind: 'dirty', branch: null, origin: null, changed: 3, unpushed: 2 },
      },
    },
    'move.target': {
      params: { origin: null, repoName: 'r', branch: 'main' },
      result: { folder: '/r', matched: true, inUse: { branch: null, running: 1 } },
    },
    'move.exportBegin': {
      params: { sessionId: 's', exportId: 'e' },
      result: { exportId: 'e', parts: 2, bytes: 9 },
    },
    'move.exportPart': {
      params: { exportId: 'e', index: 0 },
      result: { keys: [{ entries: [entry] }, { subpath: 'subagents/a', entries: [] }] },
    },
    'move.abort': { params: { exportId: 'e' }, result: {} },
    'move.importPart': {
      params: { importId: 'i', sessionId: 's', index: 0, parts: 1, keys: [{ entries: [entry] }] },
      result: {},
    },
    'move.markMoved': {
      params: { exportId: 'e', sessionId: 's', begunAt: 1, to: peer },
      result: {},
    },
  };

  for (const [name, c] of Object.entries(cases)) {
    it(`${name} parses a valid example`, () => {
      const m = methods[name as keyof typeof methods];
      expect(m.params.safeParse(c.params).success).toBe(true);
      expect(m.result.safeParse(c.result).success).toBe(true);
    });
  }

  it('move.commit takes the move and answers a chat summary', () => {
    const m = methods['move.commit'];
    const params = { importId: 'i', sessionId: 's', cwd: '/x', from: peer };
    expect(m.params.safeParse(params).success).toBe(true);
    expect(m.params.safeParse({ ...params, sessionId: undefined }).success).toBe(false);
    expect(m.result.safeParse({}).success).toBe(false);
    const summary = {
      sessionId: 's',
      title: 't',
      projectId: 'p',
      cwd: '/x',
      status: 'idle',
      preview: '',
      lastActivity: 1,
      pinned: false,
      live: false,
      external: null,
    };
    const parsed = m.result.parse({ summary });
    expect(parsed.summary?.sessionId).toBe('s');
    expect(m.result.safeParse({ summary: { ...summary, sessionId: undefined } }).success).toBe(
      false,
    );
    // Committed but not indexed yet (the index queue was busy): listed soon.
    expect(m.result.parse({ summary: null }).summary).toBeNull();
  });

  it.each(['move.check', 'move.exportBegin', 'move.importPart', 'move.markMoved'])(
    '%s rejects params without sessionId',
    (name) => {
      const without = { ...cases[name]!.params, sessionId: undefined };
      expect(methods[name as keyof typeof methods].params.safeParse(without).success).toBe(false);
    },
  );

  it('move.exportBegin takes the exportId the desktop made', () => {
    const p = methods['move.exportBegin'].params;
    expect(p.safeParse({ sessionId: 's' }).success).toBe(false);
    expect(p.parse({ sessionId: 's', exportId: 'e' }).exportId).toBe('e');
  });

  it('round-trips entries with arbitrary fields and rejects ones without a type', () => {
    const p = methods['move.importPart'].params;
    const ok = p.parse(cases['move.importPart']!.params);
    expect(ok.keys[0]!.entries[0]).toEqual(entry);
    const bad = { ...cases['move.importPart']!.params, keys: [{ entries: [{ uuid: 'x' }] }] };
    expect(p.safeParse(bad).success).toBe(false);
  });

  it('covers the git states', () => {
    const r = methods['move.check'].result;
    const base = { cwd: '/x', busy: 'turn' };
    expect(
      r.safeParse({ ...base, git: { kind: 'clean', branch: 'a', origin: null } }).success,
    ).toBe(true);
    expect(
      r.safeParse({ ...base, git: { kind: 'clean', branch: null, origin: null } }).success,
    ).toBe(true);
    expect(r.safeParse({ ...base, git: { kind: 'notRepo' } }).success).toBe(true);
    expect(r.safeParse({ ...base, git: { kind: 'weird' } }).success).toBe(false);
  });

  it('adds scheduled.create id and chat.open movedTo as optional', () => {
    const create = methods['scheduled.create'].params;
    expect(create.safeParse({ sessionId: 's', text: 't', sendAt: 1, id: 'x' }).success).toBe(true);
    expect(create.safeParse({ sessionId: 's', text: 't', sendAt: 1 }).success).toBe(true);
    const open = methods['chat.open'].result.shape;
    expect(open.movedTo.safeParse(undefined).success).toBe(true);
    expect(open.movedTo.safeParse(null).success).toBe(true);
    expect(open.movedTo.safeParse(peer).success).toBe(true);
  });
});
