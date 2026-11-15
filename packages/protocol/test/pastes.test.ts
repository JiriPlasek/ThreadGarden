import { describe, expect, it } from 'vitest';
import { draftWithReturned } from '../src/items.js';
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

describe('a draft with given-back messages', () => {
  const img = (data: string, number?: number) => ({
    mediaType: 'image/png',
    data,
    ...(number === undefined ? {} : { number }),
  });

  it('puts them in front, oldest first, as withReturned does', () => {
    expect(
      draftWithReturned({ text: 'mine', images: [] }, [{ text: 'one' }, { text: 'two' }]),
    ).toEqual({ text: 'one\ntwo\nmine', images: [] });
    expect(draftWithReturned({ text: '', images: [] }, [{ text: 'one' }])).toEqual({
      text: 'one',
      images: [],
    });
  });

  it('numbers their images past every tag and image already there', () => {
    const result = draftWithReturned(
      { text: 'see [Image #1] and [Image #3]', images: [img('A', 1)] },
      [
        { text: 'first [Image #1]', images: [img('B', 1)] },
        { text: 'second [Image #1] [Image #2]', images: [img('C', 1), img('D', 2)] },
      ],
    );
    expect(result.text).toBe(
      'first [Image #4]\nsecond [Image #5] [Image #6]\nsee [Image #1] and [Image #3]',
    );
    expect(result.images).toEqual([img('B', 4), img('C', 5), img('D', 6), img('A', 1)]);
  });

  it('leaves a typed tag with no image, and an image with no number, as they are', () => {
    const result = draftWithReturned({ text: '', images: [] }, [
      { text: 'typed [Image #7] here', images: [img('X')] },
    ]);
    expect(result).toEqual({ text: 'typed [Image #7] here', images: [img('X')] });
  });
});
