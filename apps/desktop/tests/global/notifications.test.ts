import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_OPENS_WITHIN_MS, startAttention } from '../../src/lib/notifications';
import { setup, summary } from '../layout/harness';

type ListParams = { place: { kind: string } };

const needsYou = (sessionId: string) => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
  what: 'permission: Bash(npm test)',
});

const finished = (sessionId: string) => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
});

const flush = () => new Promise((r) => setTimeout(r, 0));

const start = async (configure?: Parameters<typeof setup>[0]) => {
  const env = await setup(configure);
  const notify = vi.fn(async (title: string, body: string, sessionId: string) => {
    void [title, body, sessionId];
  });
  const setTrayNeedsYou = vi.fn(async (n: number) => void n);
  let now = 1_000_000;
  const stop = startAttention({
    api: env.client,
    settings: env.app.settings,
    tabs: env.app.tabs,
    places: env.app.places,
    notify,
    setTrayNeedsYou,
    now: () => now,
  });
  stops.push(stop);
  return { ...env, notify, setTrayNeedsYou, advance: (ms: number) => (now += ms) };
};

const stops: (() => void)[] = [];

describe('notifications', () => {
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it('notification only when chat not visible', async () => {
    const env = await start();
    env.app.tabs.openTab('s1');
    window.dispatchEvent(new Event('focus'));

    // Focused window showing that chat: no notification.
    env.server.push('needsYou', needsYou('s1'));
    await flush();
    expect(env.notify).not.toHaveBeenCalled();

    // Another tab is active: notify.
    env.server.push('needsYou', needsYou('s2'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify.mock.calls[0]).toEqual([
      'Chat s2',
      'alpha · permission: Bash(npm test)',
      's2',
    ]);

    // The window is not focused: notify even for the active tab.
    window.dispatchEvent(new Event('blur'));
    env.server.push('needsYou', needsYou('s1'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(2);

    // Notifications turned off in settings: nothing.
    env.app.settings.value = { ...env.app.settings.value, notifications: false };
    env.server.push('needsYou', needsYou('s3'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(2);
  });

  it('focus soon after a notification selects Needs you and opens the only waiting chat', async () => {
    const env = await start((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'needsYou'
          ? { items: [summary('s2', { status: 'needsYou', live: true })] }
          : { items: [] };
    });
    window.dispatchEvent(new Event('blur'));
    env.server.push('needsYou', needsYou('s2'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(1);

    env.advance(5_000);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(env.app.tabs.active).toBe('s2'));
    expect(env.app.places.selected).toEqual({ kind: 'needsYou' });
  });

  it('focus long after a notification changes nothing', async () => {
    const env = await start();
    window.dispatchEvent(new Event('blur'));
    env.server.push('needsYou', needsYou('s2'));
    await flush();
    env.advance(FOCUS_OPENS_WITHIN_MS + 1);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(env.app.places.selected).toEqual({ kind: 'active' });
    expect(env.app.tabs.active).toBeNull();
  });

  it('several chats waiting: focus selects Needs you without opening one', async () => {
    const env = await start((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'needsYou'
          ? {
              items: [
                summary('s2', { status: 'needsYou', live: true }),
                summary('s3', { status: 'needsYou', live: true }),
              ],
            }
          : { items: [] };
    });
    window.dispatchEvent(new Event('blur'));
    env.server.push('needsYou', needsYou('s2'));
    await flush();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(env.app.places.selected).toEqual({ kind: 'needsYou' }));
    await flush();
    expect(env.app.tabs.active).toBeNull();
  });

  it('chatFinished notifies only when the chat is not visible and the setting is on', async () => {
    const env = await start();
    env.app.tabs.openTab('s1');
    window.dispatchEvent(new Event('focus'));

    // The finished chat is the active tab of a focused window: no notification.
    env.server.push('chatFinished', finished('s1'));
    await flush();
    expect(env.notify).not.toHaveBeenCalled();

    // Another tab is active: notify, title first, project in the body.
    env.server.push('chatFinished', finished('s2'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify.mock.calls[0]).toEqual(['Chat s2 finished — your turn', 'alpha', 's2']);

    // The window is not focused: notify even for the active tab.
    window.dispatchEvent(new Event('blur'));
    env.server.push('chatFinished', finished('s1'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(2);

    // "Notify when a chat finishes" off: nothing, even though needs-you notifications are on.
    env.app.settings.value = { ...env.app.settings.value, notifyOnFinish: false };
    env.server.push('chatFinished', finished('s3'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(2);
    env.server.push('needsYou', needsYou('s3'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(3);
  });

  it('focus soon after a finish notification opens the chat when it is the only one waiting', async () => {
    const env = await start((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'needsYou'
          ? { items: [summary('s2', { status: 'idle', live: true, unread: true })] }
          : { items: [] };
    });
    window.dispatchEvent(new Event('blur'));
    env.server.push('chatFinished', finished('s2'));
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(1);

    env.advance(5_000);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(env.app.tabs.active).toBe('s2'));
    expect(env.app.places.selected).toEqual({ kind: 'needsYou' });
  });

  it('tray badge follows the needs-you count', async () => {
    let waiting = 2;
    const env = await start((server) => {
      server.handlers['places.counts'] = () => ({ needsYou: waiting, running: 3, all: 9 });
    });
    await env.app.places.refresh();
    expect(env.setTrayNeedsYou).toHaveBeenLastCalledWith(2);
    waiting = 0;
    await env.app.places.refresh();
    expect(env.setTrayNeedsYou).toHaveBeenLastCalledWith(0);
  });

  it('window blur sends ui.visibility false', async () => {
    const env = await start((server) => {
      server.handlers['ui.visibility'] = () => ({});
    });
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    await vi.waitFor(() =>
      expect(env.server.calls('ui.visibility').at(-1)!.params).toEqual({ visible: false }),
    );
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() =>
      expect(env.server.calls('ui.visibility').at(-1)!.params).toEqual({ visible: true }),
    );
  });
});
