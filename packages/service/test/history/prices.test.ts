import { describe, expect, it } from 'vitest';
import { costOf, priceOf } from '../../src/history/prices.js';

describe('priceOf', () => {
  it('prices every family', () => {
    expect(priceOf('claude-opus-5-5')).toEqual({
      input: 4,
      output: 20,
      cacheWrite: 5,
      cacheRead: 0.2,
    });
    expect(priceOf('gpt-6.2-sol')).toEqual({
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.1,
    });
  });

  it('dated ids', () => {
    expect(priceOf('claude-sonnet-4-5-20250929')).toEqual(priceOf('claude-sonnet-4-5'));
    expect(priceOf('claude-sonnet-4-5')).toBeDefined();
    expect(priceOf('claude-opus-4-20250514')?.input).toBe(15);
  });

  it('no prefix collisions', () => {
    expect(priceOf('claude-opus-5')?.input).toBe(5);
    expect(priceOf('claude-opus-5-5')?.input).toBe(4);
    expect(priceOf('claude-fable-5')?.cacheRead).toBe(1);
    expect(priceOf('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(priceOf('claude-opus-5-9')).toBeUndefined();
  });

  it('unknown ids', () => {
    for (const id of [
      '',
      'unknown',
      '<synthetic>',
      'claude-3-5-sonnet-20241022',
      'gpt-4o',
      'codex:gpt-6.2-sol',
    ]) {
      expect(priceOf(id), id).toBeUndefined();
    }
  });
});

describe('costOf', () => {
  it('adds every kind at its own price', () => {
    expect(
      costOf('claude-opus-5-5', {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 10_000_000,
        cacheCreation: 2_000_000,
      }),
    ).toBeCloseTo(4 + 20 + 2 + 10, 10);
  });

  it('is undefined for a model without a price', () => {
    expect(
      costOf('unknown', { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 }),
    ).toBeUndefined();
  });
});
