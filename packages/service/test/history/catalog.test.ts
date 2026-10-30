import { describe, expect, it } from 'vitest';
import { titleFor } from '../../src/history/catalog.js';

describe('titleFor', () => {
  it('follows custom → sdk title → summary → first prompt', () => {
    const all = { customTitle: 'C', sdkTitle: 'S', summary: 'U', firstPrompt: 'F' };
    expect(titleFor(all)).toBe('C');
    expect(titleFor({ ...all, customTitle: null })).toBe('S');
    expect(titleFor({ ...all, customTitle: '  ', sdkTitle: undefined })).toBe('U');
    expect(titleFor({ firstPrompt: 'F' })).toBe('F');
  });

  it('truncates the first prompt to 80 chars', () => {
    expect(titleFor({ firstPrompt: 'x'.repeat(200) })).toHaveLength(80);
    expect(titleFor({ firstPrompt: 'a\n\n  b' })).toBe('a b');
  });

  it('truncates every non-custom title but not a custom one', () => {
    const long = 'w '.repeat(100);
    expect(titleFor({ summary: long }).length).toBeLessThanOrEqual(80);
    expect(titleFor({ sdkTitle: long }).length).toBeLessThanOrEqual(80);
    expect(titleFor({ customTitle: long })).toBe(long.trim());
  });

  it('never returns empty', () => {
    expect(titleFor({})).not.toBe('');
  });
});
