import {
  AWAY_CAPABILITY,
  POWER_CAPABILITY,
  RELAY_CLOSE,
  type AwayItem,
  type AwayState,
  type ChatCopy,
  type ChatItem,
  type ChatStatus,
  type ChatTask,
  type CopyItem,
  type MachineCopy,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import type { AppState } from '../../src/lib/state/context';
import { M1, machineInfo, project, setupTwoMachines, summary } from '../layout/harness';
import { text, user } from './fixtures';

vi.setConfig({ testTimeout: 20_000 });

const HOUR = 3_600_000;

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const WAITING_OFF =
  "⏳ Waiting for Ubuntu PC — turning it on, sends when it's up. Keep this device awake.";
const WAITING_REACHABLE = "⏳ Waiting for Ubuntu PC — sends when it's reachable.";
const NOTE = 'Ubuntu PC is off: showing its last few messages, from 2 h ago.';
/** The note of a machine that isn't Off, only not connected (no plug that reads off). */
const NOTE_AWAY = "Ubuntu PC isn't connected: showing its last few messages, from 2 h ago.";

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
});

const r1 = summary('r1', { title: 'Fix the build', projectId: 'p2', cwd: '/work/infra' });

const awayItem = (over: Partial<AwayItem> = {}): AwayItem => ({
  id: 'row-1',
  machineId: M1,
  sessionId: 'r1',
  kind: 'send',
  text: 'Postgres it is',
  imageCount: 0,
  cwd: null,
  createdAt: Date.now(),
  state: 'waiting',
  reason: null,
  error: null,
  ...over,
});

type QueueParams = { machineId: string; sessionId: string; kind: 'send'; text: string };

/**
 * Ubuntu PC (M1) is away: its relay never connects. With power control (the
 * default) its plug reads off, so it shows as Off. This device's local
 * service keeps its copy (`copies.*`) and the messages waiting for it (`away.*`).
 */
const start = async (
  o: {
    power?: boolean;
    /** What the copied info says the machine can do (default: power and away). */
    capabilities?: string[];
    /** What its hello says, when that differs from its copy (default: `capabilities`). */
    helloCapabilities?: string[];
    /** A copy exists (default). */
    copy?: boolean;
    /** The copied tail of chat r1. */
    items?: CopyItem[];
    /** The copy has no info of the machine (default: it has). */
    copiedInfo?: false;
    /** Messages already waiting. */
    waiting?: AwayItem[];
    /** M1 is connected at first (default: its relay refuses from the start). */
    connected?: boolean;
    /** What M1 answers for chat r1 while connected (default: idle, three messages). */
    live?: { status: ChatStatus; items: ChatItem[]; tasks?: ChatTask[] };
  } = {},
) => {
  const capabilities = o.capabilities ?? ['remote', POWER_CAPABILITY, AWAY_CAPABILITY];
  const copiedAt = Date.now() - 2 * HOUR - 60_000;
  const machineCopy: MachineCopy = {
    machineId: M1,
    info: o.copiedInfo === false ? null : machineInfo(M1, 'ubuntu-pc', capabilities),
    projects: [{ ...project('p2', 'infra'), exists: true }],
    chats: [r1],
    copiedAt,
  };
  const chatCopy: ChatCopy = {
    machineId: M1,
    sessionId: 'r1',
    summary: r1,
    items: o.items ?? [user('u1', 'Why is CI red?'), text('a1', 'The lockfile is stale.')],
    copiedAt,
  };
  let items: AwayItem[] = o.waiting ?? [];
  const states: AwayState[] = [];
  const withPower = o.power !== false;
  const hasCopy = o.copy !== false;
  const env = await setupTwoMachines({
    waitForOn: false,
    m1Capabilities: o.helloCapabilities ?? capabilities,
    powerPasswords: { [M1]: 'pw' },
    configure: (s) => {
      const changed = () => s.push('away.changed', { items, states });
      Object.assign(s.handlers, {
        'power.list': () => (withPower ? [{ machineId: M1, config: CONFIG }] : []),
        'power.reading': () => ({ on: false, watts: 0, at: Date.now() }),
        'power.turnOn': () => ({ cycled: false, waitMs: 0 }),
        'power.unlock': () => ({}),
        'power.noteMeasurement': () => ({}),
        'copies.get': (p: unknown) =>
          hasCopy && (p as { machineId: string }).machineId === M1 ? machineCopy : null,
        'copies.chat': (p: unknown) =>
          hasCopy && (p as { sessionId: string }).sessionId === 'r1' ? chatCopy : null,
        'away.list': () => ({ items, states }),
        'away.queue': (p: unknown) => {
          const q = p as QueueParams;
          const row = awayItem({ id: `row-${items.length + 1}`, text: q.text });
          items = [...items, row];
          changed();
          return row;
        },
        'away.cancel': (p: unknown) => {
          items = items.filter((i) => i.id !== (p as { id: string }).id);
          changed();
          return {};
        },
        'away.retry': () => {
          items = items.map((i) => ({ ...i, state: 'waiting', reason: null, error: null }));
          changed();
          return {};
        },
      });
    },
    configureRemote: (s) => {
      s.refuse = o.connected !== true;
      Object.assign(s.handlers, {
        'projects.list': () => [project('p2', 'infra')],
        'chat.open': () => ({
          summary: { ...r1, status: o.live?.status ?? 'idle', live: true },
          header: {},
          items: o.live?.items ?? [
            user('u1', 'Why is CI red?'),
            text('a1', 'The lockfile is stale.'),
            user('u2', 'Postgres it is'),
          ],
          hasMore: false,
          seq: 3,
          tasks: o.live?.tasks ?? [],
        }),
        'chat.commands': () => [],
        'chat.models': () => [],
        'files.suggest': () => [],
      });
    },
  });
  apps.push(env.app);
  /** The deliverer sent everything: the local service's list empties. */
  const delivered = () => {
    items = [];
    env.server.push('away.changed', { items, states });
  };
  return { ...env, delivered };
};

/** Opens Ubuntu PC's chat r1 in the chat pane. */
const openChat = async (env: Awaited<ReturnType<typeof start>>) => {
  env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
  render(ChatPane, { context: env.context });
  await waitFor(() => expect(env.app.scopes.get(M1)?.chats.get('r1')?.loaded).toBe(true));
  const composer = (): HTMLTextAreaElement =>
    screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  return composer;
};

const queued = (env: Awaited<ReturnType<typeof start>>): QueueParams[] =>
  env.server.calls('away.queue').map((c) => c.params as QueueParams);

describe('a machine that is away', () => {
  it("an away machine's group lists its copied projects and chats with last seen", async () => {
    const env = await start();
    render(PlacesColumn, { context: env.context });
    const group = await screen.findByRole('group', { name: 'Ubuntu PC' });
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    expect(await within(group).findByRole('button', { name: /infra/ })).toBeTruthy();
    expect(within(group).getByText('last seen 2 h ago')).toBeTruthy();
    expect(within(group).queryByText("Its chats appear once it's on.")).toBeNull();

    render(ChatList, { context: env.context });
    await waitFor(() => expect(document.getElementById(`chat-row-${M1}/r1`)).not.toBeNull());
    expect(screen.getByText('Fix the build')).toBeTruthy();
    expect(screen.queryByText(/its chats are missing here/)).toBeNull();
    // Looking never turns it on.
    expect(env.server.calls('power.turnOn')).toHaveLength(0);
  });

  it('opening its chat shows the copy note and the last messages without contacting it', async () => {
    const env = await start();
    await openChat(env);
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(screen.getByText('… earlier messages are on Ubuntu PC')).toBeTruthy();
    expect(screen.getByText('Why is CI red?')).toBeTruthy();
    expect(screen.getByText('The lockfile is stale.')).toBeTruthy();
    expect(env.server.calls('copies.chat')).toHaveLength(1);
    expect(env.remote.sent).toHaveLength(0);
    expect(env.server.calls('power.turnOn')).toHaveLength(0);
  });

  it('a copied message with images says how many it had', async () => {
    const env = await start({
      items: [
        { ...user('u1', 'See the screenshot'), imageCount: 2 },
        { ...user('u2', ''), imageCount: 1 },
      ],
    });
    await openChat(env);
    expect(await screen.findByText('See the screenshot')).toBeTruthy();
    expect(screen.getByText('2 images')).toBeTruthy();
    expect(screen.getByText('1 image')).toBeTruthy();
    expect(document.querySelector('img[alt^="Attached image"]')).toBeNull();
  });

  it('sending queues the message and shows the waiting line with Cancel', async () => {
    const env = await start();
    const composer = await openChat(env);
    await userEvent.type(composer(), 'Postgres it is{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(queued(env)[0]).toMatchObject({
      machineId: M1,
      sessionId: 'r1',
      kind: 'send',
      text: 'Postgres it is',
    });
    const line = await screen.findByText(WAITING_OFF);
    expect(screen.getByText('Postgres it is')).toBeTruthy();
    expect(composer().value).toBe('');
    const row = line.closest('[data-away-item]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(WAITING_OFF)).toBeNull());
    expect(env.server.calls('away.cancel')[0]!.params).toEqual({ id: 'row-1' });
  });

  it('a waiting message says how many images it has, and one of images only is not an empty row', async () => {
    const env = await start({
      waiting: [
        awayItem({ id: 'row-1', text: 'See these', imageCount: 1 }),
        awayItem({ id: 'row-2', text: '', imageCount: 3 }),
      ],
    });
    await openChat(env);
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-away-item]')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(within(rows[0]!).getByText('See these')).toBeTruthy();
    expect(within(rows[0]!).getByText('1 image')).toBeTruthy();
    expect(within(rows[1]!).getByText('3 images')).toBeTruthy();
    for (const p of rows[1]!.querySelectorAll('p')) expect(p.textContent?.trim()).not.toBe('');
  });

  it("without a plug that reads off, the note and the line say it isn't connected", async () => {
    const env = await start({ power: false });
    const composer = await openChat(env);
    expect(await screen.findByText(NOTE_AWAY)).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
    await userEvent.type(composer(), 'Postgres it is{Enter}');
    expect(await screen.findByText(WAITING_REACHABLE)).toBeTruthy();
    expect(screen.queryByText(WAITING_OFF)).toBeNull();
  });

  it('a failed start shows the line and Retry', async () => {
    const env = await start({ waiting: [awayItem({ state: 'failed', reason: 'start' })] });
    await openChat(env);
    const line = await screen.findByText("Ubuntu PC didn't come up");
    const row = line.closest('[data-away-item]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(env.server.calls('away.retry')).toHaveLength(1));
    expect(env.server.calls('away.retry')[0]!.params).toEqual({ machineId: M1 });
    expect(await screen.findByText(WAITING_OFF)).toBeTruthy();
    expect(screen.queryByText("Ubuntu PC didn't come up")).toBeNull();
  });

  it('when the machine connects the chat is live again and the waiting line goes', async () => {
    const env = await start({ power: false, waiting: [awayItem()] });
    await openChat(env);
    expect(await screen.findByText(NOTE_AWAY)).toBeTruthy();
    expect(screen.getByText(WAITING_REACHABLE)).toBeTruthy();

    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    env.delivered();
    await waitFor(() => expect(screen.queryByText(NOTE_AWAY)).toBeNull());
    expect(env.remote.calls('chat.open').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText(WAITING_REACHABLE)).toBeNull());
    expect(screen.queryByText('… earlier messages are on Ubuntu PC')).toBeNull();
    // The message the machine took is in the live chat.
    expect(await screen.findByText('Postgres it is')).toBeTruthy();
  });

  it('a live send waits behind a waiting row of its chat', async () => {
    const env = await start({ power: false, waiting: [awayItem()] });
    await openChat(env);
    expect(await screen.findByText(WAITING_REACHABLE)).toBeTruthy();
    // The machine is back, but the deliverer hasn't sent the waiting row yet.
    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    await waitFor(() => expect(screen.queryByText(NOTE_AWAY)).toBeNull());
    // No Schedule send while one waits: it could go out first.
    expect(screen.queryByRole('button', { name: 'More send options' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'And the docs{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(queued(env)[0]).toMatchObject({ sessionId: 'r1', kind: 'send', text: 'And the docs' });
    expect(env.remote.calls('chat.send')).toHaveLength(0);
    expect(env.remote.calls('chat.resumeCheck')).toHaveLength(0);

    // Once nothing of the chat waits, a message goes to the machine live.
    env.delivered();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'More send options' })).toBeTruthy(),
    );
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'Thanks{Enter}');
    await waitFor(() => expect(env.remote.calls('chat.send')).toHaveLength(1));
    expect(queued(env)).toHaveLength(1);
  });

  it("a send waits behind its chat's row that didn't come up, and goes live past a refused one", async () => {
    const env = await start({
      power: false,
      connected: true,
      waiting: [awayItem({ state: 'failed', reason: 'start' })],
    });
    await openChat(env);
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    const composer = () => screen.getByRole('textbox', { name: /message/i });
    await userEvent.type(composer(), 'Follow-up{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(env.remote.calls('chat.send')).toHaveLength(0);

    // A refused row needs Retry: it holds nothing back.
    env.server.push('away.changed', {
      items: [awayItem({ state: 'failed', reason: 'refused', error: 'No such chat' })],
      states: [],
    });
    await screen.findByText('No such chat');
    await userEvent.type(composer(), 'Live{Enter}');
    await waitFor(() => expect(env.remote.calls('chat.send')).toHaveLength(1));
    expect(queued(env)).toHaveLength(1);
  });

  it("a machine without the away capability can't queue", async () => {
    const env = await start({ capabilities: ['remote', POWER_CAPABILITY] });
    const composer = await openChat(env);
    expect(await screen.findByText("Update Ubuntu PC to send while it's off")).toBeTruthy();
    expect(composer().disabled).toBe(true);
    expect(screen.getByRole('button', { name: /^send/i })).toHaveProperty('disabled', true);
    expect(queued(env)).toHaveLength(0);
  });

  it("a machine known neither from a hello nor from its copy hasn't been seen yet", async () => {
    const env = await start({ copiedInfo: false });
    const composer = await openChat(env);
    expect(await screen.findByText("Ubuntu PC hasn't been seen yet")).toBeTruthy();
    expect(screen.queryByText("Update Ubuntu PC to send while it's off")).toBeNull();
    expect(composer().disabled).toBe(true);
    expect(queued(env)).toHaveLength(0);
  });

  it('a machine whose address answers as another one takes no message', async () => {
    const env = await start({ power: false, connected: true });
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'));
    const composer = await openChat(env);
    env.remote.refuse = true;
    env.remote.drop(RELAY_CLOSE.mismatch);
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('mismatch'));
    expect(
      await screen.findByText(
        "Can't send to Ubuntu PC: its address answers as a different machine",
      ),
    ).toBeTruthy();
    expect(composer().disabled).toBe(true);
    expect(queued(env)).toHaveLength(0);
  });

  it("a machine never seen shows Its chats appear once it's on", async () => {
    const env = await start({ copy: false });
    render(PlacesColumn, { context: env.context });
    const group = await screen.findByRole('group', { name: 'Ubuntu PC' });
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    await waitFor(() => expect(env.server.calls('copies.get').length).toBeGreaterThan(0));
    expect(within(group).getByText("Its chats appear once it's on.")).toBeTruthy();
    expect(within(group).queryByText(/last seen/)).toBeNull();
  });

  it('a permission request in the copy is shown, and a typed answer is queued as the next message', async () => {
    const env = await start({
      items: [
        user('u1', 'Clean up the build folder'),
        {
          kind: 'permissionRequest',
          id: 'p1',
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'rm -rf build' },
          suggestions: [],
          state: 'pending',
          variant: 'tool',
        },
      ],
    });
    const composer = await openChat(env);
    expect(await screen.findByRole('group', { name: 'Permission request: Bash' })).toBeTruthy();
    expect(
      screen.getByText(
        "Claude asked this before Ubuntu PC went off. Type your answer below; it's sent as your next message.",
      ),
    ).toBeTruthy();
    await userEvent.type(composer(), 'No, keep it{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(queued(env)[0]).toMatchObject({ sessionId: 'r1', kind: 'send', text: 'No, keep it' });
    expect(env.server.calls('chat.respond')).toHaveLength(0);
  });

  it('a chat open live whose machine goes away stops looking live, and an answer is queued', async () => {
    const env = await start({
      power: false,
      connected: true,
      live: {
        status: 'working',
        items: [
          user('u1', 'Clean up the build folder'),
          {
            kind: 'permissionRequest',
            id: 'p1',
            requestId: 'req-1',
            toolName: 'Bash',
            input: { command: 'rm -rf build' },
            suggestions: [],
            state: 'pending',
            variant: 'tool',
          },
        ],
      },
    });
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'));
    const composer = await openChat(env);
    const header = screen.getByRole('banner');
    // Live: working, with Stop.
    expect(await within(header).findByRole('img', { name: 'Working' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

    env.remote.refuse = true;
    env.remote.drop();
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('unreachable'));
    // No plug reads it off: it isn't connected, not Off.
    expect(
      await screen.findByText("Ubuntu PC isn't connected: showing the chat as it was"),
    ).toBeTruthy();
    expect(screen.queryByText(/is off/)).toBeNull();
    expect(within(header).queryByRole('img', { name: 'Working' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(
      screen.getByText(
        "Claude asked this before Ubuntu PC went off. Type your answer below; it's sent as your next message.",
      ),
    ).toBeTruthy();
    // The card can't be answered: it offers no buttons, and the composer stays.
    const card = screen.getByRole('group', { name: 'Permission request: Bash' });
    expect(within(card).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(queued(env)).toHaveLength(0);
    // A typed answer waits as the next message.
    await userEvent.type(composer(), 'No, keep it{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(queued(env)[0]).toMatchObject({ sessionId: 'r1', kind: 'send', text: 'No, keep it' });
    expect(env.remote.calls('chat.respond')).toHaveLength(0);
    expect(env.server.calls('chat.respond')).toHaveLength(0);
  });

  it('a tab never shows a chat of a machine that is away as working, and does again once it is back', async () => {
    const env = await start({
      power: false,
      connected: true,
      live: { status: 'working', items: [user('u1', 'Build it')] },
    });
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'));
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
    render(TabsBar, { context: env.context });
    await waitFor(() => expect(env.app.scopes.get(M1)?.chats.get('r1')?.loaded).toBe(true));
    const tab = (): HTMLElement =>
      document.querySelector(`[data-chat-key="${M1}/r1"]`) as HTMLElement;
    expect(await within(tab()).findByRole('img', { name: 'Working' })).toBeTruthy();

    env.remote.refuse = true;
    env.remote.drop();
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('unreachable'));
    await waitFor(() => expect(within(tab()).queryByRole('img', { name: 'Working' })).toBeNull());
    expect(within(tab()).getByRole('img', { name: 'Idle' })).toBeTruthy();

    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    expect(await within(tab()).findByRole('img', { name: 'Working' })).toBeTruthy();
  });

  it('a machine updated and off again before its copy caught up can still be written to', async () => {
    // Its copy is from before the update; its last hello (this run) says `away`.
    const env = await start({
      power: false,
      connected: true,
      capabilities: ['remote'],
      helloCapabilities: ['remote', AWAY_CAPABILITY],
    });
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'));
    const composer = await openChat(env);
    env.remote.refuse = true;
    env.remote.drop();
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('unreachable'));
    await waitFor(() => expect(env.app.scopes.get(M1)?.copy?.has).toBe(true));
    expect(screen.queryByText("Update Ubuntu PC to send while it's off")).toBeNull();
    expect(composer().disabled).toBe(false);
    await userEvent.type(composer(), 'Postgres it is{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
  });

  it('running tasks of a chat whose machine is away are not shown, and are again once it is back', async () => {
    const env = await start({
      power: false,
      connected: true,
      live: {
        status: 'idle',
        items: [user('u1', 'Start the dev server')],
        tasks: [
          {
            taskId: 't1',
            kind: 'shell',
            description: 'npm run dev',
            status: 'running',
            startedAt: Date.now(),
          },
        ],
      },
    });
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'));
    await openChat(env);
    render(TabsBar, { context: env.context });
    // While away, the list's row for r1 comes from the copy (M1 lists nothing while on).
    render(ChatList, { context: env.context });
    // The tab's badge and the Activity panel's count.
    await waitFor(() => expect(screen.getAllByText('1 running')).toHaveLength(2));

    env.remote.refuse = true;
    env.remote.drop();
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('unreachable'));
    await waitFor(() => expect(document.getElementById(`chat-row-${M1}/r1`)).not.toBeNull());
    await waitFor(() => expect(screen.queryAllByText('1 running')).toHaveLength(0));

    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    await waitFor(() => expect(screen.getAllByText('1 running')).toHaveLength(2));
  });

  it('a message going out says Sending…, and can no longer be cancelled', async () => {
    const env = await start({ waiting: [awayItem({ state: 'sending' })] });
    await openChat(env);
    const line = await screen.findByText('Sending…');
    const row = line.closest('[data-away-item]') as HTMLElement;
    expect(within(row).getByText('Postgres it is')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText(WAITING_OFF)).toBeNull();
  });
});
