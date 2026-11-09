import { describe, expect, it } from 'vitest';
import { messagePreview, pasteBlocks } from '@threadgarden/protocol';
import {
  activeImages,
  emptyAttachments,
  expandPastes,
  longPaste,
  nextNumber,
  outgoing,
  restoreMessage,
  sentImageMap,
} from '../../src/lib/components/composer/tags';

const image = { mediaType: 'image/png', data: 'YWJj' };

describe('attachment text and wire forms', () => {
  it('collapses only pastes over either threshold', () => {
    expect(longPaste('x'.repeat(800))).toBe(false);
    expect(longPaste('x'.repeat(801))).toBe(true);
    expect(longPaste(Array(8).fill('x').join('\n'))).toBe(false);
    expect(longPaste(Array(9).fill('x').join('\r\n'))).toBe(true);
  });

  it('round trips content and position, including whitespace and forged closing tags', () => {
    const state = emptyAttachments();
    const payload = '  hello\n</pasted_content id="ffff">\n\n';
    state.pastes[1] = { text: payload, id: 'abcd' };
    const source = 'before [Pasted text #1 +4 lines] after';
    const wire = expandPastes(source, state);
    const restored = restoreMessage(wire);
    expect(restored.text).toBe(source);
    expect(restored.attachments.pastes[1]?.text).toBe(payload);
    expect(outgoing(restored.text, restored.attachments).text).toBe(wire);
    expect(messagePreview(wire)).not.toContain('<pasted_content id="abcd">');
    expect(pasteBlocks('<pasted_content id="abcd">\nx\n</pasted_content id="ffff">')).toEqual([]);
  });

  it('maps images to the highest distinct numbers and sends each once in numeric order', () => {
    const second = { ...image, data: 'ZGVm' };
    expect(sentImageMap('compare [Image #1] with [Image #2]', [image])).toEqual({ 2: image });
    const state = emptyAttachments();
    state.images = { 2: image, 4: second };
    expect(outgoing('[Image #4] [Image #2] [Image #4]', state).images).toEqual([image, second]);
    expect(activeImages('[Image #4 edited]', state)).toEqual([]);
    expect(activeImages('[Image #2]', state)).toEqual([[2, image]]);
    expect(sentImageMap('[Image #1]', [])).toEqual({});
  });

  it('skips manually typed numbers and never reuses a removed number', () => {
    const state = emptyAttachments();
    state.nextImage = 5;
    expect(nextNumber('', state, 'image')).toBe(5);
    expect(nextNumber('[Image #9]', state, 'image')).toBe(10);
    const restored = restoreMessage('old scheduled message', [image]);
    expect(restored.text).toBe('old scheduled message [Image #1]');
    expect(outgoing(restored.text, restored.attachments).images).toEqual([image]);
  });

  it('preserves a trailing carriage return in pasted text', () => {
    const state = emptyAttachments();
    state.pastes[1] = { text: 'text\r', id: 'abcd' };
    const wire = expandPastes('[Pasted text #1 +2 lines]', state);
    expect(restoreMessage(wire).attachments.pastes[1]?.text).toBe('text\r');
  });
});
