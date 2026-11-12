import { setEditorSelection } from '../../src/lib/components/composer/editor';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pasteBlocks } from '@threadgarden/protocol';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import { LOCAL } from '../layout/harness';
import { fill, renderChat, SID } from './helpers';

beforeEach(() => {
  // jsdom has no layout; preview visibility now follows the anchor's actual bounds.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 350, 100, 20),
  );
});
afterEach(() => vi.restoreAllMocks());

const paste = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
const pasteText = async (el: HTMLDivElement, text = paste) => {
  await fireEvent.paste(el, { clipboardData: { files: [], items: [], getData: () => text } });
};
const pasteImage = async (el: HTMLDivElement) => {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  await fireEvent.paste(el, { clipboardData: { files: [image], items: [] } });
};

describe('attachment tags in the composer', () => {
  it('keeps an IME composition intact and undoes it as one edit', async () => {
    const { composer } = await renderChat();
    await fill(composer(), 'before ');
    await fireEvent.compositionStart(composer());
    for (const value of ['before n', 'before ni', 'before 日本']) {
      await fireEvent(
        composer(),
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          isComposing: true,
          bubbles: true,
        }),
      );
      composer().textContent = value;
      setEditorSelection(composer(), value.length);
      await fireEvent.input(composer(), { isComposing: true });
    }
    await fireEvent.compositionEnd(composer());
    expect(composer().textContent).toBe('before 日本');
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(composer().textContent).toBe('before ');
  });

  it('edits a scheduled paste with its image and restores the previous draft', async () => {
    const wire = `<pasted_content id="abcd">\n${paste}\n</pasted_content id="abcd">\n\n[Image #2]`;
    const scheduled = {
      id: 'x1',
      sessionId: SID,
      text: wire,
      imageCount: 1,
      sendAt: Date.now() + 3600000,
      createdAt: Date.now(),
      state: 'pending',
      afterLimitReset: false,
      rescheduled: false,
    };
    const { composer, server } = await renderChat({
      configure: (s) => {
        s.handlers['scheduled.list'] = () => ({ items: [scheduled] });
        s.handlers['scheduled.get'] = () => ({
          ...scheduled,
          images: [{ mediaType: 'image/png', data: 'YWJj', number: 2 }],
        });
        s.handlers['scheduled.update'] = () => scheduled;
      },
    });
    await pasteText(composer(), 'x'.repeat(801));
    const draft = composer().textContent;
    const list = await screen.findByRole('region', { name: 'Scheduled messages' });
    expect(list.textContent).not.toContain('<pasted_content');
    await userEvent.click(within(list).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(composer().textContent).toContain('[Image #2]'));
    expect(composer().textContent).toContain('[Pasted text #1 +40 lines]');
    await userEvent.click(screen.getByRole('button', { name: 'Save scheduled message' }));
    await waitFor(() => expect(server.calls('scheduled.update')).toHaveLength(1));
    const sent = server.calls('scheduled.update')[0]!.params as { text: string; images: unknown[] };
    expect(pasteBlocks(sent.text)[0]?.text).toBe(paste);
    expect(sent.images).toEqual([{ mediaType: 'image/png', data: 'YWJj', number: 2 }]);
    await waitFor(() => expect(composer().textContent).toBe(draft));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(
      pasteBlocks((server.calls('chat.send')[0]!.params as { text: string }).text)[0]?.text,
    ).toBe('x'.repeat(801));
  });

  it('inserts a long paste at the caret, previews it, and expands it on send', async () => {
    const { composer, server } = await renderChat();
    await fill(composer(), 'before after');
    setEditorSelection(composer(), 7);
    await pasteText(composer());
    expect(composer().textContent).toBe('before [Pasted text #1 +40 lines]after');
    const badge = screen.getByRole('button', { name: '[Pasted text #1 +40 lines]' });
    await fireEvent.focusIn(badge);
    expect(screen.getByRole('tooltip').textContent).toContain('line 40');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    const sent = server.calls('chat.send')[0]!.params as { text: string };
    expect(pasteBlocks(sent.text)[0]?.text).toBe(paste);
    expect(sent.text.startsWith('before \n\n<pasted_content')).toBe(true);
    expect(sent.text.endsWith('\n\nafter')).toBe(true);
    await waitFor(() => expect(composer().textContent).toBe(''));
  });

  it('keeps images and pastes on remount and retains removed attachments for undo', async () => {
    const { composer, server, view, context } = await renderChat();
    await pasteImage(composer());
    await waitFor(() => expect(composer().textContent).toBe('[Image #1]'));
    await pasteText(composer());
    const value = composer().textContent;
    view.unmount();
    const next = render(ChatView, {
      props: { ref: { machineId: LOCAL, sessionId: SID } },
      context,
    });
    const box = screen.getByRole('textbox', { name: /message/i }) as HTMLDivElement;
    await waitFor(() => expect(box.textContent).toBe(value));
    expect(screen.getByRole('list', { name: 'Attached images' })).toBeTruthy();
    await fill(box, 'edited');
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull();
    await fill(box, value);
    expect(screen.getByRole('list', { name: 'Attached images' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
    expect(box.textContent).not.toContain('[Image #1]');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    const sent = server.calls('chat.send')[0]!.params as { text: string; images?: unknown[] };
    expect(pasteBlocks(sent.text)[0]?.text).toBe(paste);
    expect(sent.images ?? []).toEqual([]);
    next.unmount();
  });

  it('saves full paste text and restores it after a fresh app state; images are missing', async () => {
    const first = await renderChat();
    await pasteImage(first.composer());
    await waitFor(() => expect(first.composer().textContent).toBe('[Image #1]'));
    await pasteText(first.composer());
    first.view.unmount();
    await waitFor(() => expect(first.server.calls('drafts.set').length).toBeGreaterThan(0));
    const saved = (first.server.calls('drafts.set').at(-1)!.params as { text: string }).text;
    expect(pasteBlocks(saved)[0]?.text).toBe(paste);
    const second = await renderChat({
      configure: (s) => {
        s.handlers['drafts.get'] = () => ({ text: saved });
      },
    });
    await waitFor(() =>
      expect(second.composer().textContent).toContain('[Pasted text #1 +40 lines]'),
    );
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull();
    await fireEvent.focusIn(screen.getByRole('button', { name: '[Image #1]' }));
    expect(screen.getByRole('tooltip').textContent).toContain("This image wasn't kept");
  });
});

describe('sent attachment badges', () => {
  it('keeps legacy plain text, raw pastes and untagged image thumbnails readable', async () => {
    const original = `Old message\n${'raw pasted log line\n'.repeat(20)}end`;
    await renderChat({
      items: [
        {
          kind: 'user',
          id: 'legacy',
          ts: 0,
          text: original,
          images: [
            { mediaType: 'image/png', data: 'YWJj' },
            { mediaType: 'image/png', data: 'ZGVm' },
          ],
        },
      ],
    });
    const messages = screen.getByLabelText('Messages');
    expect(messages.textContent).toContain(original);
    // An old message without positional tags keeps both thumbnails.
    expect(within(messages).getAllByRole('img', { name: /Attached image/ })).toHaveLength(2);
    expect(within(messages).queryByRole('button', { name: /Pasted text|Image #/ })).toBeNull();
  });
  it('shows an image on the tag it was sent with and pins a pasted-text preview on click', async () => {
    await renderChat({
      items: [
        {
          kind: 'user',
          id: 'u1',
          ts: 0,
          text: `compare [Image #1] with [Image #2]\n\n<pasted_content id="abcd">\n${paste}\n</pasted_content id="abcd">\n\n`,
          images: [{ mediaType: 'image/png', data: 'YWJj', number: 2 }],
        },
      ],
    });
    const messages = screen.getByLabelText('Messages');
    expect(within(messages).queryByRole('button', { name: '[Image #1]' })).toBeNull();
    const badge = within(messages).getByRole('button', { name: '[Image #2]' });
    await fireEvent.focus(badge);
    expect(within(screen.getByRole('tooltip')).getByRole('img').getAttribute('src')).toBe(
      'data:image/png;base64,YWJj',
    );
    const pasted = within(messages).getByRole('button', { name: '[Pasted text #1 +40 lines]' });
    await userEvent.click(pasted);
    await fireEvent.mouseLeave(pasted);
    expect(screen.getByRole('tooltip').textContent).toBe(paste);
    await userEvent.click(screen.getByRole('textbox', { name: /message/i }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
