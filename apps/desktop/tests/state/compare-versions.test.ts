import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/lib/state/connection.svelte';

describe('compareVersions', () => {
  it('compares each part as a number, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
    expect(compareVersions('0.9.10', '0.9.9')).toBe(1);
  });

  it('equal versions, missing parts and pre-release tails', () => {
    expect(compareVersions('0.9.0', '0.9.0')).toBe(0);
    expect(compareVersions('0.9', '0.9.0')).toBe(0);
    expect(compareVersions('0.9.1', '0.9')).toBe(1);
    // A tail after - or + is not compared: 0.9.0-rc.1 counts as 0.9.0.
    expect(compareVersions('0.9.0-rc.1', '0.9.0')).toBe(0);
  });
});
