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
  it('is protocol 9 and accepts remotes at 8 to 10', () => {
    expect(PROTOCOL_VERSION).toBe(9);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 8, max: 10 });
    expect([7, 8, 9, 10, 11].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
  });

  it('has the move capability and error codes', () => {
    expect(MOVE_CAPABILITY).toBe('move');
    expect(CAPABILITIES).toContain('move');
    expect(MOVE_ERRORS.moving).toBe('MOVING');
    expect(MOVE_ERRORS.expired).toBe('EXPIRED');
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
      params: { sessionId: 's' },
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
    'move.markMoved': { params: { exportId: 'e', to: peer }, result: {} },
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
    expect(parsed.summary.sessionId).toBe('s');
    expect(m.result.safeParse({ summary: { ...summary, sessionId: undefined } }).success).toBe(
      false,
    );
  });

  it.each(['move.check', 'move.exportBegin', 'move.importPart'])(
    '%s rejects params without sessionId',
    (name) => {
      const without = { ...cases[name]!.params, sessionId: undefined };
      expect(methods[name as keyof typeof methods].params.safeParse(without).success).toBe(false);
    },
  );

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
