import { describe, expect, it } from 'vitest';
import { UNTITLED_TITLE, titleFor } from '../../src/history/catalog.js';

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
    expect(titleFor({})).toBe(UNTITLED_TITLE);
  });

  // ── v1.2 C1: chat titles ──

  it('v1.2: custom → generated → Claude Code title/summary → provisional → first prompt', () => {
    const all = {
      customTitle: 'Custom',
      generatedTitle: 'Generated',
      sdkTitle: 'Sdk',
      summary: 'Summary',
      autoTitle: 'Provisional',
      firstPrompt: 'First prompt',
    };
    expect(titleFor(all)).toBe('Custom');
    expect(titleFor({ ...all, customTitle: null })).toBe('Generated');
    expect(titleFor({ ...all, customTitle: null, generatedTitle: ' ' })).toBe('Sdk');
    const noTitles = { ...all, customTitle: null, generatedTitle: null, sdkTitle: null };
    // A chat Threadgarden named ignores the SDK summary (fix round 1, M1); others keep it.
    expect(titleFor(noTitles)).toBe('Provisional');
    expect(titleFor({ ...noTitles, autoTitle: null })).toBe('Summary');
    expect(titleFor({ autoTitle: 'Provisional', firstPrompt: 'First prompt' })).toBe('Provisional');
    expect(titleFor({ firstPrompt: 'First prompt' })).toBe('First prompt');
  });

  it('v1.2: an SDK summary that is only the first prompt does not hide the provisional title', () => {
    // The SDK's summary falls back to the first prompt for a chat without a title.
    const prompt = 'Fix the login bug. It fails on Safari after the redirect.';
    expect(
      titleFor({ summary: prompt, firstPrompt: prompt, autoTitle: 'Fix the login bug.' }),
    ).toBe('Fix the login bug.');
    expect(
      titleFor({
        summary: ` ${prompt}
`,
        firstPrompt: prompt,
      }),
    ).toBe(titleFor({ firstPrompt: prompt }));
  });

  it('v1.2: a chat Threadgarden named ignores the SDK summary (only its last prompt for SDK chats)', () => {
    // Claude Code's own titles arrive as sdkTitle; the summary of an untitled
    // SDK chat is its last prompt, which must not replace Threadgarden's name.
    expect(
      titleFor({ summary: 'Third message', firstPrompt: 'First', autoTitle: 'Provisional' }),
    ).toBe('Provisional');
    expect(
      titleFor({ summary: 'Third message', autoTitle: 'Provisional', sdkTitle: 'Renamed in CLI' }),
    ).toBe('Renamed in CLI');
    // Without a Threadgarden name the summary still ranks above the first prompt.
    expect(titleFor({ summary: 'Third message', firstPrompt: 'First' })).toBe('Third message');
  });

  it('v1.2: generated and provisional titles are truncated to 80 chars like other non-custom ones', () => {
    const long = 'w '.repeat(100);
    expect(titleFor({ generatedTitle: long }).length).toBeLessThanOrEqual(80);
    expect(titleFor({ autoTitle: long }).length).toBeLessThanOrEqual(80);
  });
});
