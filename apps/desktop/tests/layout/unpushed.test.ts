import {
  POWER_CAPABILITY,
  RELAY_CLOSE,
  type MachinePowerStatus,
  type Unpushed,
} from '@threadgarden/protocol';
import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import { describeUnpushed } from '../../src/lib/components/UnpushedNotice.svelte';
import { startAttention } from '../../src/lib/notifications';
import type { AppState } from '../../src/lib/state/context';
import type { FakeServer } from '../service/fake-ws';
import { M1, project, setupTwoMachines } from './harness';

vi.setConfig({ testTimeout: 15_000 });

const item = (over: Partial<Unpushed> = {}): Unpushed => ({
  repo: '/home/jiri/work/tg-cli',
  branch: 'main',
  kind: 'unpushed',
  count: 2,
  sessionId: 's1',
  reason: null,
  ...over,
});

const status = (over: Partial<MachinePowerStatus> = {}): MachinePowerStatus => ({
  configured: true,
  busy: false,
  idleSince: null,
  shutsDownAt: null,
  keepAwake: { mode: 'off', until: null },
  phase: 'running',
  unpushed: [],
  problem: null,
  ...over,
});

const blocked = (unpushed: Unpushed[] = [item()]): MachinePowerStatus =>
  status({ phase: 'blocked', unpushed });

let apps: AppState[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  for (const app of apps) app.power.stop();
  apps = [];
});

const start = async (current: () => MachinePowerStatus = () => blocked()) => {
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', POWER_CAPABILITY],
    powerPasswords: { [M1]: 'pw' },
    configure: (s: FakeServer) => {
      s.handlers['power.list'] = () => [];
      s.handlers['power.unlock'] = () => ({});
    },
    configureRemote: (s: FakeServer) => {
      s.handlers['projects.list'] = () => [project('p2', 'infra')];
      s.handlers['power.status'] = () => current();
      s.handlers['power.adopt'] = () => ({});
      s.handlers['power.shutdown'] = () => current();
      s.handlers['chat.send'] = () => ({ queued: false });
    },
  });
  apps.push(env.app);
  env.app.places.select({ kind: 'needsYou' });
  render(PlacesColumn, { context: env.context });
  render(ChatList, { context: env.context });
  return env;
};

describe('unpushed work in Needs you', () => {
  it('blocked machine shows the notice first and bumps the count', async () => {
    await start();
    const notice = await screen.findByRole('region', { name: 'Unpushed work on Ubuntu PC' });
    expect(within(notice).getByRole('heading').textContent).toBe('Unpushed work on Ubuntu PC');
    const items = within(notice).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('tg-cli main: 2 commits not on GitHub');
    const needsYou = screen.getByRole('button', { name: /^Needs you/ });
    expect(within(needsYou).getByText('1')).toBeTruthy();
  });

  it('Ask Claude to push it sends the message to the session', async () => {
    const { remote } = await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Claude to push it' }));
    await waitFor(() => expect(remote.calls('chat.send')).toHaveLength(1));
    expect(remote.calls('chat.send')[0]!.params).toMatchObject({
      sessionId: 's1',
      text: 'Please commit and push your work in tg-cli so the machine can shut down.',
    });
    // Not hidden optimistically: it goes when the machine leaves blocked.
    expect(screen.getByRole('region', { name: 'Unpushed work on Ubuntu PC' })).toBeTruthy();
  });

  it('offers no ask button for an item without a chat', async () => {
    await start(() => blocked([item({ sessionId: null, kind: 'unchecked', reason: 'no git' })]));
    const notice = await screen.findByRole('region', { name: 'Unpushed work on Ubuntu PC' });
    expect(within(notice).queryByRole('button', { name: 'Ask Claude to push it' })).toBeNull();
    expect(within(notice).getByText("tg-cli: couldn't check (no git)")).toBeTruthy();
  });

  it('Shut down anyway sends force, and the notice goes once the machine leaves blocked', async () => {
    const { remote } = await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Shut down anyway' }));
    await waitFor(() => expect(remote.calls('power.shutdown')).toHaveLength(1));
    expect(remote.calls('power.shutdown')[0]!.params).toEqual({ force: true });
    expect(screen.getByRole('region', { name: 'Unpushed work on Ubuntu PC' })).toBeTruthy();
    remote.push('power.changed', status());
    await waitFor(() => expect(screen.queryByRole('region', { name: /Unpushed work/ })).toBeNull());
  });

  it('notification fires once per blocked transition', async () => {
    const env = await setupTwoMachines({
      m1Capabilities: ['remote', POWER_CAPABILITY],
      powerPasswords: { [M1]: 'pw' },
      configure: (s) => {
        s.handlers['power.list'] = () => [];
        s.handlers['power.unlock'] = () => ({});
      },
      configureRemote: (s) => {
        s.handlers['projects.list'] = () => [];
        s.handlers['power.status'] = () => status();
        s.handlers['power.adopt'] = () => ({});
      },
    });
    apps.push(env.app);
    const notify = vi.fn(
      async (title: string, body: string, key: string) => void [title, body, key],
    );
    stops.push(
      startAttention({
        scopes: env.app.scopes,
        machines: env.app.machines,
        settings: env.app.settings,
        tabs: env.app.tabs,
        places: env.app.places,
        power: env.app.power,
        notify,
        setTrayNeedsYou: vi.fn(async () => {}),
      }),
    );
    await waitFor(() => expect(env.app.power.machine(M1)?.phase).toBe('running'));
    expect(notify).not.toHaveBeenCalled();

    env.remote.push('power.changed', blocked());
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![0]).toBe('Unpushed work on Ubuntu PC — shutdown is paused');

    env.remote.push('power.changed', blocked([item({ count: 3 })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(notify).toHaveBeenCalledTimes(1);

    env.remote.push('power.changed', status());
    await waitFor(() => expect(env.app.power.machine(M1)?.phase).toBe('running'));
    env.remote.push('power.changed', blocked());
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  });
});

describe('the Needs you count', () => {
  it('ignores a blocked status while the machine link is closed', async () => {
    const env = await start();
    await screen.findByRole('region', { name: 'Unpushed work on Ubuntu PC' });
    env.remote.drop(RELAY_CLOSE.locked);
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('locked'));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Unpushed work/ })).toBeNull());
    expect(env.app.power.blockedIds()).toEqual([]);
    expect(env.app.power.needsYouCount(0)).toBe(0);
  });

  it('the tray count includes a blocked machine', async () => {
    const env = await setupTwoMachines({
      m1Capabilities: ['remote', POWER_CAPABILITY],
      powerPasswords: { [M1]: 'pw' },
      configure: (s) => {
        s.handlers['power.list'] = () => [];
        s.handlers['power.unlock'] = () => ({});
      },
      configureRemote: (s) => {
        s.handlers['projects.list'] = () => [];
        s.handlers['power.status'] = () => status();
        s.handlers['power.adopt'] = () => ({});
      },
    });
    apps.push(env.app);
    const setTray = vi.fn(async (n: number) => void n);
    stops.push(
      startAttention({
        scopes: env.app.scopes,
        machines: env.app.machines,
        settings: env.app.settings,
        tabs: env.app.tabs,
        places: env.app.places,
        power: env.app.power,
        notify: vi.fn(async () => {}),
        setTrayNeedsYou: setTray,
      }),
    );
    await waitFor(() => expect(env.app.power.machine(M1)?.phase).toBe('running'));
    env.remote.push('power.changed', blocked());
    await waitFor(() => expect(setTray).toHaveBeenLastCalledWith(1));
    env.remote.push('power.changed', status());
    await waitFor(() => expect(setTray).toHaveBeenLastCalledWith(0));
  });
});

describe('describeUnpushed', () => {
  it('words each kind', () => {
    const d = describeUnpushed;
    const stash = { kind: 'uncommitted', branch: null, reason: 'stashed changes' } as const;
    expect(d(item({ ...stash, count: 1 }))).toBe('tg-cli: 1 stashed change');
    expect(d(item({ ...stash, count: 2 }))).toBe('tg-cli: 2 stashed changes');
    expect(d(item({ kind: 'uncommitted', count: 3 }))).toBe('tg-cli: 3 uncommitted changes');
    expect(d(item({ kind: 'uncommitted', count: 1 }))).toBe('tg-cli: 1 uncommitted change');
    expect(d(item({ count: 1 }))).toBe('tg-cli main: 1 commit not on GitHub');
    expect(d(item({ branch: null }))).toBe('tg-cli (detached HEAD): 2 commits not on GitHub');
    expect(d(item({ repo: 'C:\\work\\tg-cli', kind: 'unchecked', reason: 'timed out' }))).toBe(
      "tg-cli: couldn't check (timed out)",
    );
  });
});
