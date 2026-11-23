import { fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { user, text } from '../chat/fixtures';
import { fill, pushItems, renderChat, SID } from './helpers';

it('browses sent messages backwards and forwards, returning to the empty composer', async () => {
  const { composer, server } = await renderChat({
    items: [user('first', 'First message'), text('reply', 'Answer'), user('last', 'Last message')],
  });
  composer().focus();
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('Last message'));
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('First message'));
  await userEvent.keyboard('{ArrowUp}');
  expect(composer().textContent).toBe('First message');
  await userEvent.keyboard('{ArrowDown}');
  expect(composer().textContent).toBe('Last message');
  await userEvent.keyboard('{ArrowDown}');
  expect(composer().textContent).toBe('');
  expect(server.calls('chat.send')).toHaveLength(0);
});

it('preserves drafts and stops browsing as soon as a recalled message is edited', async () => {
  const { composer } = await renderChat({ items: [user('old', 'Older'), user('new', 'Newer')] });
  await fill(composer(), 'My\nunfinished draft');
  expect(await fireEvent.keyDown(composer(), { key: 'ArrowUp' })).toBe(true);
  expect(composer().textContent).toBe('My\nunfinished draft');
  await fill(composer(), '');
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('Newer'));
  await fill(composer(), 'Edited newer');
  expect(await fireEvent.keyDown(composer(), { key: 'ArrowUp' })).toBe(true);
  expect(await fireEvent.keyDown(composer(), { key: 'ArrowDown' })).toBe(true);
  expect(composer().textContent).toBe('Edited newer');
});

it('resends the original text, pasted content and images', async () => {
  const image = { mediaType: 'image/png', data: 'AAAA', number: 3 };
  const original = `Check this [Image #3]\n${'Pasted source line\n'.repeat(100)}End`;
  const { composer, server } = await renderChat({
    items: [user('sent', original, { images: [image] })],
  });
  composer().focus();
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toContain('[Image #3]'));
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
  expect(server.calls('chat.send')[0]!.params).toEqual({
    sessionId: SID,
    text: original,
    images: [image],
  });
  expect(composer().textContent).toBe('');
});

it('skips subagent messages and Threadgarden move notes, and loads older pages on demand', async () => {
  const { app, composer, server } = await renderChat({
    items: [
      user('newest', 'Newest'),
      user('child', 'Subagent prompt', { parentToolUseId: 'agent' }),
      user('move', '[Threadgarden] This chat moved from A to B.'),
    ],
    configure: (server) => {
      server.handlers['chat.older'] = () => ({ items: [user('older', 'Older')], hasMore: false });
    },
  });
  app.chats.get(SID)!.hasMore = true;
  composer().focus();
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('Newest'));
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('Older'));
  expect(server.calls('chat.older').length).toBeGreaterThan(0);
});

it('does not overwrite typing when an older page finishes loading', async () => {
  let finish!: (value: unknown) => void;
  const { app, composer, server } = await renderChat({
    items: [user('latest', 'Latest')],
    configure: (server) => {
      server.handlers['chat.older'] = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
    },
  });
  composer().focus();
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('Latest'));
  app.chats.get(SID)!.hasMore = true;
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(server.calls('chat.older')).toHaveLength(1));
  await fill(composer(), 'Keep what I typed');
  finish({ items: [user('old', 'Old')], hasMore: false });
  await waitFor(() => expect(app.chats.get(SID)!.loadingOlder).toBe(false));
  expect(composer().textContent).toBe('Keep what I typed');
});

it('keeps browsing stable when a new user message arrives', async () => {
  const { composer, server } = await renderChat({ items: [user('a', 'A'), user('b', 'B')] });
  composer().focus();
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('B'));
  pushItems(server, 2, [user('c', 'C')]);
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('A'));
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
  await waitFor(() => expect(composer().textContent).toBe('C'));
});
