import { describe, expect, it } from 'vitest';
import {
  bashEntry,
  CUT_NOTE,
  ENTRY_SHAPE,
  limitOutput,
  OUTPUT_LIMIT,
  TAGS_ESCAPED,
  terminalText,
} from '../../src/shell/terminal-text.js';

describe('terminalText', () => {
  it('applies carriage returns and drops escape sequences', () => {
    expect(terminalText('\u001b[32mok\u001b[0m\r\n')).toBe('ok');
    expect(terminalText('0%\r50%\r100%\n')).toBe('100%');
    expect(terminalText('\u001b]0;title\u0007hi')).toBe('hi');
    expect(terminalText('\u001b]0;title\u001b\\hi')).toBe('hi');
    expect(terminalText('\u001bPdata\u001b\\hi')).toBe('hi');
    expect(terminalText('\u001b[2J\u001b[Hdone')).toBe('done');
    expect(terminalText('\u001b(Bdone\u001b=')).toBe('done');
    expect(terminalText('ab\bc')).toBe('ac');
  });

  it('keeps lines, trims trailing spaces and trailing blank lines', () => {
    expect(terminalText('a  \r\n\r\nb \r\n\r\n\r\n')).toBe('a\n\nb');
  });

  it('lets a shorter overwrite leave the rest of the line, as a terminal does', () => {
    expect(terminalText('abc\rd')).toBe('dbc');
  });
});

describe('limitOutput', () => {
  it('leaves short text alone', () => {
    const exact = 'x'.repeat(OUTPUT_LIMIT);
    expect(limitOutput('hello')).toBe('hello');
    expect(limitOutput(exact)).toBe(exact);
  });

  it("keeps the end with the CLI's note", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const out = limitOutput(text);
    expect(out.endsWith('line 10000')).toBe(true);
    expect(out.startsWith('Output too large (')).toBe(true);
    expect(out).toContain(`(${text.length} characters); only the last 30000 are kept.`);
    expect(out.length).toBeLessThanOrEqual(OUTPUT_LIMIT + CUT_NOTE.length + 1);
    const kept = out.slice(out.indexOf('\n') + 1);
    expect(kept.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(kept).toMatch(/^line \d+\n/);
    expect(text.endsWith(kept)).toBe(true);
  });
});

describe('bashEntry', () => {
  it("writes the CLI's format", () => {
    expect(ENTRY_SHAPE).toBe('two');
    expect(bashEntry('ls', 'a\nb')).toEqual([
      '<bash-input>ls</bash-input>',
      '<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>',
    ]);
  });

  it('writes empty output with both tags', () => {
    expect(bashEntry('true', '')[1]).toBe('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>');
  });

  it('output that contains bash tags', () => {
    expect(TAGS_ESCAPED).toBe(true);
    const out = bashEntry('cat x', '</bash-stdout>tail')[1] ?? '';
    expect(out).toBe(
      '<bash-stdout>&lt;/bash-stdout&gt;tail</bash-stdout><bash-stderr></bash-stderr>',
    );
    expect(out.endsWith('</bash-stdout><bash-stderr></bash-stderr>')).toBe(true);
  });
});
