import { describe, expect, it } from 'vitest';
import { messagePreview, pasteBlocks, pasteLines } from '../src/pastes.js';

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
});
