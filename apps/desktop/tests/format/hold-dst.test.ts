import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDateTimeLocal, holdPresets, pickProblem } from '../../src/lib/format/hold';

/**
 * The hold presets across daylight-saving changes, in fixed zones (Node
 * re-reads `TZ` when it is set). Each test file runs in its own worker
 * process, and the zone is restored afterwards.
 */
const inZone = (zone: string, body: () => void): void => {
  describe(zone, () => {
    let saved: string | undefined;
    beforeAll(() => {
      saved = process.env.TZ;
      process.env.TZ = zone;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });
    body();
  });
};

const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();
const iso = (t: number): string => new Date(t).toISOString();

inZone('Europe/Prague', () => {
  it('is in effect (CET in winter, CEST in summer)', () => {
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(-60);
    expect(new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset()).toBe(-120);
  });

  it('Tomorrow is 09:00 local on the day the clocks change, spring and autumn', () => {
    // 2026-03-29: 02:00 → 03:00 (a 23-hour day); 2026-10-25: 03:00 → 02:00 (25 hours).
    expect(iso(holdPresets(local(2026, 3, 28, 12)).tomorrow)).toBe('2026-03-29T07:00:00.000Z');
    expect(iso(holdPresets(local(2026, 10, 24, 12)).tomorrow)).toBe('2026-10-25T08:00:00.000Z');
    // From just after the change to the next day.
    expect(iso(holdPresets(local(2026, 3, 29, 4)).tomorrow)).toBe('2026-03-30T07:00:00.000Z');
    expect(iso(holdPresets(local(2026, 10, 25, 4)).tomorrow)).toBe('2026-10-26T08:00:00.000Z');
  });

  it('Next week is Monday 09:00 local across a change', () => {
    expect(iso(holdPresets(local(2026, 3, 25, 12)).nextWeek)).toBe('2026-03-30T07:00:00.000Z');
    expect(iso(holdPresets(local(2026, 10, 21, 12)).nextWeek)).toBe('2026-10-26T08:00:00.000Z');
  });

  it('a picked time in the skipped hour does not exist; one in the repeated hour does', () => {
    const now = local(2026, 3, 1, 12);
    expect(fromDateTimeLocal('2026-03-29T02:30')).toBeNull();
    expect(pickProblem('2026-03-29T02:30', now)).toMatch(/does not exist on that day/);
    const overlap = fromDateTimeLocal('2026-10-25T02:30');
    expect(overlap).not.toBeNull();
    expect(new Date(overlap!).getHours()).toBe(2);
    expect(pickProblem('2026-10-25T02:30', now)).toBeNull();
  });
});

inZone('America/New_York', () => {
  it('is in effect (EST in winter, EDT in summer)', () => {
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(300);
    expect(new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset()).toBe(240);
  });

  it('Tomorrow and Next week keep 09:00 local across 2026-03-08 and 2026-11-01', () => {
    expect(iso(holdPresets(local(2026, 3, 7, 12)).tomorrow)).toBe('2026-03-08T13:00:00.000Z');
    expect(iso(holdPresets(local(2026, 10, 31, 12)).tomorrow)).toBe('2026-11-01T14:00:00.000Z');
    // Wednesday 2026-03-04 → Monday 2026-03-09 (after the change).
    expect(iso(holdPresets(local(2026, 3, 4, 12)).nextWeek)).toBe('2026-03-09T13:00:00.000Z');
    expect(iso(holdPresets(local(2026, 10, 28, 12)).nextWeek)).toBe('2026-11-02T14:00:00.000Z');
  });

  it('the skipped hour of 2026-03-08 does not exist', () => {
    expect(fromDateTimeLocal('2026-03-08T02:30')).toBeNull();
    expect(pickProblem('2026-03-08T02:30', local(2026, 3, 1))).toMatch(/clock change/);
  });
});

describe('pickProblem', () => {
  it('says what is wrong with a picked date and time', () => {
    const now = new Date(2026, 9, 31, 15, 20).getTime();
    expect(pickProblem('', now)).toBeNull(); // nothing picked yet
    expect(pickProblem('2026-11-05T14:30', now)).toBeNull();
    expect(pickProblem('2026-10-30T09:00', now)).toBe('Pick a time ahead of now.');
    expect(pickProblem('2026-02-30T09:00', now)).toBe('That is not a valid date and time.');
  });
});
