import { describe, expect, it } from 'vitest';
import { messagePreview, pasteBlocks, pasteLines, unwrapPastes } from '../src/pastes.js';

describe('CLI paste blocks', () => {
  it('matches the closing id and leaves malformed blocks readable as text', () => {
    const source =
      'before <pasted_content id="abcd">\none\n</pasted_content id="ffff">\ntwo\n</pasted_content id="abcd"> after';
    expect(pasteBlocks(source)[0]?.text).toBe('one\n</pasted_content id="ffff">\ntwo');
    expect(messagePreview(source)).toBe('before [Pasted text #1 +3 lines] after');
    const malformed = '<pasted_content id="abcd">\none';
    expect(messagePreview(malformed)).toBe(malformed);
    expect(pasteLines('a\r\nb\rc\n')).toBe(4);
  });

  it('unwraps blocks to the text as typed and the pastes the CLI wraps again', () => {
    // As CLI 2.1.319 writes `inline_pastes` into the transcript: blank lines around
    // a block, a single newline when it ends the message.
    const wire =
      'Before \n\n<pasted_content id="f348">\none\ntwo\n</pasted_content id="f348">\n\n after:' +
      '\n\n<pasted_content id="058b">\nthree\n</pasted_content id="058b">\n';
    expect(unwrapPastes(wire)).toEqual({
      text: 'Before one\ntwo after:three',
      pastes: ['one\ntwo', 'three'],
    });
    expect(unwrapPastes('no pastes\n\n')).toEqual({ text: 'no pastes\n\n', pastes: [] });
  });

  it('takes blank lines once between back-to-back blocks', () => {
    const block = (id: string, text: string) =>
      `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n\n`;
    expect(unwrapPastes(`a${block('aaaa', 'x')}${block('bbbb', 'y')}b`)).toEqual({
      text: 'axyb',
      pastes: ['x', 'y'],
    });
  });
});
