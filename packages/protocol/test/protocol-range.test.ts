import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REMOTE_PROTOCOL_RANGE, acceptsRemoteProtocol } from '../src/index.js';

/**
 * The phone's core (Rust) re-states `acceptsRemoteProtocol` and reads this
 * fixture in its tests; this side pins the fixture to the rule, so the two
 * can't drift.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/protocol-range.json', import.meta.url), 'utf8'),
) as { min: number; max: number; samples: { version: number; accepts: boolean }[] };

describe('the protocol range fixture', () => {
  it('is the range a desktop accepts from a remote service', () => {
    expect({ min: fixture.min, max: fixture.max }).toEqual(REMOTE_PROTOCOL_RANGE);
  });

  it.each(fixture.samples)('says what acceptsRemoteProtocol says of $version', (s) => {
    expect(acceptsRemoteProtocol(s.version)).toBe(s.accepts);
  });

  it('covers both ends and just past them', () => {
    const versions = fixture.samples.map((s) => s.version);
    for (const v of [fixture.min - 1, fixture.min, fixture.max, fixture.max + 1]) {
      expect(versions).toContain(v);
    }
  });
});
