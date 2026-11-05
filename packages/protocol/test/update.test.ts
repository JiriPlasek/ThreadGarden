import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  UPDATE_CAPABILITY,
  UPDATE_ERRORS,
  UpdateStatusSchema,
  VERSION_PATTERN,
  acceptsRemoteProtocol,
  events,
  methods,
} from '../src/index.js';

describe('protocol 10 (update)', () => {
  it('PROTOCOL_VERSION is 11 and the remote range is 10..12', () => {
    expect(PROTOCOL_VERSION).toBe(11);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 10, max: 12 });
    expect([9, 10, 11, 12, 13].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
  });

  it('has the update capability and error codes', () => {
    expect(UPDATE_CAPABILITY).toBe('update');
    expect(UPDATE_ERRORS).toEqual({
      NOT_SUPPORTED: 'NOT_SUPPORTED',
      UPDATE_RUNNING: 'UPDATE_RUNNING',
      ALREADY_CURRENT: 'ALREADY_CURRENT',
      INVALID_VERSION: 'INVALID_VERSION',
      UNREACHABLE: 'UNREACHABLE',
    });
  });

  it('VERSION_PATTERN accepts 0.7.1 and 1.0.0-rc.1, rejects ../x, .hidden and an empty string', () => {
    expect(VERSION_PATTERN.test('0.7.1')).toBe(true);
    expect(VERSION_PATTERN.test('1.0.0-rc.1')).toBe(true);
    expect(VERSION_PATTERN.test('../x')).toBe(false);
    expect(VERSION_PATTERN.test('.hidden')).toBe(false);
    expect(VERSION_PATTERN.test('')).toBe(false);
  });

  it('frozen: v10 update.start and update.status payloads keep parsing', () => {
    expect(methods['update.start'].params.safeParse({ version: '0.7.1', force: false }).success).toBe(
      true,
    );
    const started = methods['update.start'].result;
    expect(started.safeParse({ started: false, busy: 2 }).success).toBe(true);
    expect(started.safeParse({ started: true }).success).toBe(true);

    const samples = [
      { state: 'idle' },
      { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'downloading' },
      { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'installing' },
      { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'restarting' },
      { state: 'done', version: '0.7.1', from: '0.7.0', skipped: [] },
      { state: 'done', version: '0.7.1', from: '0.7.0', skipped: ['linger', 'polkit'] },
      { state: 'failed', version: '0.7.1', from: '0.7.0', reason: 'checksum' },
      { state: 'failed', version: '0.7.1', from: '0.7.0', reason: 'start', detail: 'timed out' },
      // A later protocol may add fields; they must not break an older reader.
      { state: 'idle', note: 'x' },
    ];
    for (const s of samples) {
      expect(UpdateStatusSchema.safeParse(s).success, JSON.stringify(s)).toBe(true);
      expect(methods['update.status'].result.safeParse(s).success).toBe(true);
      expect(events['update.progress'].safeParse(s).success).toBe(true);
    }
    expect(UpdateStatusSchema.safeParse({ state: 'sleeping' }).success).toBe(false);
  });

  it('methods lists update.latest, update.start, update.status', () => {
    expect(Object.keys(methods)).toEqual(
      expect.arrayContaining(['update.latest', 'update.start', 'update.status']),
    );
    expect(methods['update.latest'].result.parse({ version: '0.7.1' })).toEqual({ version: '0.7.1' });
  });

  it('events lists update.progress', () => {
    expect(Object.keys(events)).toContain('update.progress');
  });
});
