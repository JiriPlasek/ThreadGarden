import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAttention } from '../../src/lib/notifications';
import { M1, setupTwoMachines } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const start = async () => {
  const env = await setupTwoMachines();
  const notify = vi.fn(async (title: string, body: string, chatKey: string) => {
    void [title, body, chatKey];
  });
  const setTrayNeedsYou = vi.fn(async (n: number) => void n);
  const setActiveChat = vi.fn(async (machineId: string | null, sessionId: string | null) => {
    void [machineId, sessionId];
  });
  stops.push(
    startAttention({
      scopes: env.app.scopes,
      machines: env.app.machines,
      settings: env.app.settings,
      tabs: env.app.tabs,
      places: env.app.places,
      power: env.app.power,
      notify,
      setTrayNeedsYou,
      setActiveChat,
    }),
  );
  return { ...env, notify, setTrayNeedsYou, setActiveChat };
};

describe('alerts on the phone', () => {
  it('the webview posts no alerts', async () => {
    const env = await start();
    window.dispatchEvent(new Event('blur'));
    env.remote.push('needsYou', {
      sessionId: 'r1',
      title: 'Chat r1',
      projectName: 'tg-cli',
      what: 'permission: Bash(npm test)',
    });
    env.remote.push('chatFinished', { sessionId: 'r2', title: 'Chat r2', projectName: 'tg-cli' });
    env.remote.push('chatBackFromHold', { sessionId: 'r3', title: 'Chat r3', projectName: 'x' });
    // Chats waiting: the desktop would put the count on its tray icon.
    env.remote.handlers['places.counts'] = () => ({
      needsYou: 2,
      running: 0,
      all: 2,
      active: 2,
      onHold: 0,
      archived: 0,
    });
    env.remote.push('sessions.changed', { sessionIds: ['r1'] });
    await new Promise((r) => setTimeout(r, 600));
    expect(env.notify).not.toHaveBeenCalled();
    expect(env.setTrayNeedsYou).not.toHaveBeenCalled();
    // The machine's other clients keep their focus state: the phone never reports its own.
    expect(env.remote.calls('ui.visibility')).toHaveLength(0);
    expect(env.server.calls('ui.visibility')).toHaveLength(0);
  });

  it('the open chat is told to the core', async () => {
    const env = await start();
    expect(env.setActiveChat).toHaveBeenLastCalledWith(null, null);
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
    await flush();
    expect(env.setActiveChat).toHaveBeenLastCalledWith(M1, 'r1');
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r2' });
    await flush();
    expect(env.setActiveChat).toHaveBeenLastCalledWith(M1, 'r2');
    // The app went to the background: no chat is in front of the owner.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.setActiveChat).toHaveBeenLastCalledWith(null, null);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.setActiveChat).toHaveBeenLastCalledWith(M1, 'r2');
    env.app.tabs.close({ machineId: M1, sessionId: 'r1' });
    env.app.tabs.close({ machineId: M1, sessionId: 'r2' });
    await flush();
    expect(env.setActiveChat).toHaveBeenLastCalledWith(null, null);
    const calls = env.setActiveChat.mock.calls.length;
    // Nothing changed: the core is not told again.
    env.app.tabs.close({ machineId: M1, sessionId: 'r2' });
    await flush();
    expect(env.setActiveChat.mock.calls.length).toBe(calls);
  });
});
