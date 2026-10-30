import { describe, expect, it } from 'vitest';
import { checkResume, externalStatus, resumeCommand } from '../../src/external/resume-safety.js';
import { parseAgents, type ExternalSession } from '../../src/external/poller.js';

const ext = (o: Partial<ExternalSession>): ExternalSession => ({
  cwd: '/p',
  kind: 'interactive',
  startedAt: 1,
  raw: {},
  ...o,
});

const NOW = 10_000_000;
const check = (external: ExternalSession[] | null, lastModified = 0) =>
  checkResume({ sessionId: 's1', external, lastModified, now: NOW });

describe('checkResume', () => {
  it('blocked when listed with live pid', () => {
    const r = check([ext({ sessionId: 's1', pid: 42, status: 'idle' })]);
    expect(r.status).toBe('blocked');
    expect(r.reason).not.toBe('');
  });

  it('blocked when state working or blocked', () => {
    for (const state of ['working', 'blocked']) {
      const r = check([ext({ sessionId: 's1', kind: 'background', state })]);
      expect(r.status, state).toBe('blocked');
    }
  });

  it('blocked when in doubt: unknown state or status without a pid', () => {
    expect(check([ext({ sessionId: 's1', state: 'hibernating' })]).status).toBe('blocked');
    expect(check([ext({ sessionId: 's1', status: 'busy' })]).status).toBe('blocked');
    expect(check([ext({ sessionId: 's1' })]).status).toBe('blocked');
  });

  it('ok when listed done without pid', () => {
    for (const state of ['done', 'failed', 'stopped']) {
      expect(check([ext({ sessionId: 's1', kind: 'background', state })]).status, state).toBe('ok');
    }
  });

  it('blocked when any of several entries for the session is live', () => {
    const r = check([
      ext({ sessionId: 's1', kind: 'background', state: 'done' }),
      ext({ sessionId: 's1', pid: 7 }),
    ]);
    expect(r.status).toBe('blocked');
  });

  it('ok when not listed', () => {
    expect(check([ext({ sessionId: 'other', pid: 1 }), ext({})]).status).toBe('ok');
    expect(check([]).status).toBe('ok');
  });

  it('unverified when external is null', () => {
    const r = check(null);
    expect(r.status).toBe('unverified');
    expect(r.reason).toMatch(/cannot check|can.t check/i);
  });

  it('recentlyModified within 2 minutes', () => {
    expect(check([], NOW - 119_999).recentlyModified).toBe(true);
    expect(check([], NOW - 120_000).recentlyModified).toBe(false);
    expect(check(null, NOW - 1_000).recentlyModified).toBe(true);
    expect(check([], 0).recentlyModified).toBe(false);
  });
});

describe('externalStatus', () => {
  const s = (o: Partial<ExternalSession>) => externalStatus(ext(o));

  it('follows the status table', () => {
    expect(s({ status: 'waiting', pid: 1 })).toBe('needsYou');
    expect(s({ kind: 'background', state: 'blocked' })).toBe('needsYou');
    expect(s({ status: 'busy', pid: 1 })).toBe('working');
    expect(s({ kind: 'background', state: 'working' })).toBe('working');
    expect(s({ status: 'idle', pid: 1 })).toBe('idle');
    expect(s({ kind: 'background', state: 'done', pid: 1 })).toBe('idle');
    expect(s({ kind: 'background', state: 'failed' })).toBe('failed');
  });

  it('done without pid is history, not running', () => {
    expect(s({ kind: 'background', state: 'done' })).toBe('history');
    expect(s({ kind: 'background', state: 'stopped' })).toBe('history');
  });

  it('unknown values are unknown', () => {
    expect(s({ status: 'levitating', pid: 1 })).toBe('unknown');
    expect(s({ state: 'hibernating' })).toBe('unknown');
    expect(s({})).toBe('unknown');
  });
});

describe('resumeCommand', () => {
  it('uses claude attach for background sessions', () => {
    const list = [ext({ sessionId: 's1', kind: 'background', shortId: '979fd9f6' })];
    expect(resumeCommand('s1', list)).toBe('claude attach 979fd9f6');
  });

  it('uses claude --resume otherwise', () => {
    expect(resumeCommand('s1', [ext({ sessionId: 's1', pid: 3 })])).toBe('claude --resume s1');
    expect(resumeCommand('s1', [ext({ sessionId: 's1', kind: 'background' })])).toBe(
      'claude --resume s1',
    );
    expect(resumeCommand('s1', [])).toBe('claude --resume s1');
    expect(resumeCommand('s1', null)).toBe('claude --resume s1');
  });

  it('works on parsed real output', () => {
    const list = parseAgents(
      JSON.stringify([
        {
          id: '979fd9f6',
          cwd: '/x',
          kind: 'background',
          startedAt: 1,
          sessionId: 'bg',
          state: 'blocked',
        },
      ]),
    );
    expect(resumeCommand('bg', list)).toBe('claude attach 979fd9f6');
  });
});
