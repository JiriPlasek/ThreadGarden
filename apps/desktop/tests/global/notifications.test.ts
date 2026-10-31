import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_OPENS_WITHIN_MS, startAttention } from '../../src/lib/notifications';
import { here, M1, setup, setupTwoMachines, summary } from '../layout/harness';

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
  const notify = vi.fn(async (title: string, body: string, chatKey: string) => {
    void [title, body, chatKey];
  });
  const setTrayNeedsYou = vi.fn(async (n: number) => void n);
  let now = 1_000_000;
  const stop = startAttention({
    scopes: env.app.scopes,
    machines: env.app.machines,
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
      here('s2'),
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
    await vi.waitFor(() => expect(env.app.tabs.active).toBe(here('s2')));
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
    expect(env.notify.mock.calls[0]).toEqual(['Chat s2 finished — your turn', 'alpha', here('s2')]);

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
    await vi.waitFor(() => expect(env.app.tabs.active).toBe(here('s2')));
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

  it('v1.3 B: a scheduled message that went out is announced, late ones say so', async () => {
    const env = await start();
    window.dispatchEvent(new Event('blur'));
    const sent = { sessionId: 's1', title: 'Fix the build', projectName: 'alpha', dueAt: 1 };
    env.server.push('scheduledSent', { ...sent, late: false });
    await flush();
    expect(env.notify).toHaveBeenLastCalledWith(
      'Scheduled message sent to Fix the build',
      'alpha',
      here('s1'),
    );
    env.server.push('scheduledSent', { ...sent, late: true });
    await flush();
    expect(env.notify.mock.calls.at(-1)?.[1]).toMatch(/^alpha · sent late/);
    env.app.settings.value = { ...env.app.settings.value, notifications: false };
    env.server.push('scheduledSent', { ...sent, late: false });
    await flush();
    expect(env.notify).toHaveBeenCalledTimes(2);
  });
});

describe('notifications across machines', () => {
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  const startTwo = async (o: Parameters<typeof setupTwoMachines>[0] = {}) => {
    const env = await setupTwoMachines(o);
    const notify = vi.fn(async (title: string, body: string, chatKey: string) => {
      void [title, body, chatKey];
    });
    const setTrayNeedsYou = vi.fn(async (n: number) => void n);
    stops.push(
      startAttention({
        scopes: env.app.scopes,
        machines: env.app.machines,
        settings: env.app.settings,
        tabs: env.app.tabs,
        places: env.app.places,
        notify,
        setTrayNeedsYou,
      }),
    );
    return { ...env, notify, setTrayNeedsYou };
  };

  it('names the machine in notifications from other machines', async () => {
    const { server, remote, notify } = await startTwo();
    window.dispatchEvent(new Event('blur'));
    remote.push('needsYou', {
      sessionId: 's1',
      title: 'Scaffold',
      projectName: 'tg-cli',
      what: 'needs permission',
    });
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Scaffold',
        'Ubuntu PC · tg-cli · needs permission',
        `${M1}/s1`,
      ),
    );
    // This PC's are not prefixed.
    server.push('needsYou', needsYou('s1'));
    await vi.waitFor(() =>
      expect(notify).toHaveBeenLastCalledWith(
        'Chat s1',
        'alpha · permission: Bash(npm test)',
        here('s1'),
      ),
    );
    remote.push('chatFinished', { sessionId: 's2', title: 'Infra', projectName: 'infra' });
    await vi.waitFor(() =>
      expect(notify).toHaveBeenLastCalledWith(
        'Infra finished — your turn',
        'Ubuntu PC · infra',
        `${M1}/s2`,
      ),
    );
  });

  it('a chat of the same id on another machine is not the one on screen', async () => {
    const { app, remote, notify } = await startTwo();
    app.tabs.openTab('s1');
    window.dispatchEvent(new Event('focus'));
    // This PC's s1 is on screen: Ubuntu PC's s1 still notifies.
    remote.push('needsYou', needsYou('s1'));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![2]).toBe(`${M1}/s1`);
    // Now Ubuntu PC's s1 is on screen: it does not.
    app.tabs.openTab({ machineId: M1, sessionId: 's1' });
    remote.push('needsYou', needsYou('s1'));
    await flush();
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('focus soon after a notification opens the only waiting chat on its machine', async () => {
    const { app, remote, notify } = await startTwo({
      configureRemote: (s) => {
        s.handlers['sessions.list'] = (p) =>
          (p as ListParams).place.kind === 'needsYou'
            ? { items: [summary('s1', { status: 'needsYou', live: true })] }
            : { items: [] };
      },
    });
    window.dispatchEvent(new Event('blur'));
    remote.push('needsYou', needsYou('s1'));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(app.tabs.active).toBe(`${M1}/s1`));
    expect(app.places.selected).toEqual({ kind: 'needsYou' });
  });

  it('sets the tray from the sum once, not per machine', async () => {
    const counts = (n: number) => () => ({ needsYou: n, running: 0, all: 0 });
    const { app, setTrayNeedsYou } = await startTwo({
      configure: (s) => (s.handlers['places.counts'] = counts(2)),
      configureRemote: (s) => (s.handlers['places.counts'] = counts(3)),
    });
    await app.places.refresh();
    await app.scopes.get(M1)!.places.refresh();
    await vi.waitFor(() => expect(setTrayNeedsYou).toHaveBeenLastCalledWith(5));
    expect(setTrayNeedsYou.mock.calls.map((c) => c[0])).not.toContain(3);
  });
});
