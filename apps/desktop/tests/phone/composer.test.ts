import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderChat } from '../interaction/helpers';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;

const pasteImage = async (el: HTMLElement) => {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  await fireEvent.paste(el, { clipboardData: { files: [image], items: [] } });
};

describe('the composer on the phone', () => {
  it('is a plain textarea: tags are text, a delete next to one takes it whole', async () => {
    const { server } = await renderChat();
    expect(box()).toBeInstanceOf(HTMLTextAreaElement);
    await userEvent.type(box(), 'see ');
    await pasteImage(box());
    await waitFor(() => expect(box().value).toBe('see [Image #1]'));

    // Gboard's backspace: no Backspace key, only the delete input, and Chrome has
    // already selected the character it deletes (seen on Android 15, Chrome 124).
    box().setSelectionRange(box().value.length - 1, box().value.length);
    const backspace = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    await fireEvent(box(), backspace);
    expect(backspace.defaultPrevented).toBe(true);
    expect(box().value).toBe('see ');

    await pasteImage(box());
    await waitFor(() => expect(box().value).toBe('see [Image #2]'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    const sent = server.calls('chat.send')[0]!.params as { text: string; images: unknown[] };
    expect(sent.text).toBe('see [Image #2]');
    expect(sent.images).toEqual([expect.objectContaining({ number: 2 })]);
  });
});
