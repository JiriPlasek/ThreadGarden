import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { manyItems, text, user } from '../chat/fixtures';
import { bashRequest, pushItems, renderChat, SID } from './helpers';

/** The chat's scroll viewport. */
const viewportOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-viewport]')!;

/** Scrolls up like the user would: following new output pauses. */
const scrollUp = async (viewport: HTMLElement, to = 1000) => {
  viewport.scrollTop = to;
  await fireEvent.scroll(viewport);
  expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();
};

describe('autoscroll on send (v1.1 §5)', () => {
  it('sending while scrolled up jumps to the bottom and keeps following new output', async () => {
    const items = manyItems(300);
    const env = await renderChat({ items });
    const viewport = viewportOf(env.view.container);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(1000));
    const bottom = viewport.scrollTop;

    await scrollUp(viewport);
    await userEvent.type(env.composer(), 'one more thing{Enter}');
    await waitFor(() => expect(env.server.calls('chat.send')).toHaveLength(1));
    await waitFor(() => expect(viewport.scrollTop).toBe(bottom));
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    // The new turn streams in: the view follows it.
    pushItems(env.server, 2, [user('u-new', 'one more thing'), text('a-new', 'on it')]);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(bottom));
    const following = viewport.scrollTop;
    pushItems(env.server, 3, [text('a-new2', 'and more')]);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(following));

    // Scrolling up afterwards pauses following again.
    await scrollUp(viewport, 500);
    pushItems(env.server, 4, [text('a-new3', 'even more')]);
    await new Promise((r) => setTimeout(r, 30));
    expect(viewport.scrollTop).toBe(500);
  });

  it('a queued send (Claude working) also jumps to the bottom', async () => {
    const env = await renderChat({ status: 'working', items: manyItems(300) });
    const viewport = viewportOf(env.view.container);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(1000));
    const bottom = viewport.scrollTop;
    await scrollUp(viewport);
    await userEvent.type(env.composer(), 'also this{Enter}');
    await waitFor(() => expect(env.app.chats.get(SID)?.queuedMessages).toBe(1));
    await waitFor(() => expect(viewport.scrollTop).toBe(bottom));
  });

  it('answering a permission request while scrolled up sticks to the bottom', async () => {
    const env = await renderChat({
      status: 'needsYou',
      items: [...manyItems(300), bashRequest()],
    });
    const viewport = viewportOf(env.view.container);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(1000));
    const bottom = viewport.scrollTop;
    await scrollUp(viewport);

    // The card is far below; answer it through its "waiting for you" jump, then scroll up again.
    await userEvent.click(screen.getByRole('button', { name: /^show$/i }));
    const card = await screen.findByRole('group', { name: /permission request/i });
    // Up a little, so the card stays rendered.
    await scrollUp(viewport, bottom - 100);
    await userEvent.click(within(card).getByRole('button', { name: /^allow$/i }));
    await waitFor(() => expect(env.server.calls('chat.respond')).toHaveLength(1));
    await waitFor(() => expect(viewport.scrollTop).toBe(bottom));

    // Work resumes: new output is followed.
    pushItems(env.server, 2, [bashRequest({ state: 'allowed' }), text('after', 'done')]);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(bottom));
  });

  it('stickToBottom on the chat state re-enables following for a chat not on screen', async () => {
    const env = await renderChat({ items: manyItems(30) });
    const chat = env.app.chats.get(SID)!;
    chat.view.stick = false;
    env.app.chats.stickToBottom(SID);
    expect(chat.view.stick).toBe(true);
    // Unknown chats are ignored.
    expect(() => env.app.chats.stickToBottom('nope')).not.toThrow();
  });
});
