import {
  AWAY_CAPABILITY,
  POWER_CAPABILITY,
  type AwayItem,
  type AwayState,
  type ChatCopy,
  type ChatItem,
  type ChatStatus,
  type CopyItem,
  type MachineCopy,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
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
    /** A copy exists (default). */
    copy?: boolean;
    /** The copied tail of chat r1. */
    items?: CopyItem[];
    /** Messages already waiting. */
    waiting?: AwayItem[];
    /** M1 is connected at first (default: its relay refuses from the start). */
    connected?: boolean;
    /** What M1 answers for chat r1 while connected (default: idle, three messages). */
    live?: { status: ChatStatus; items: ChatItem[] };
  } = {},
) => {
  const capabilities = o.capabilities ?? ['remote', POWER_CAPABILITY, AWAY_CAPABILITY];
  const copiedAt = Date.now() - 2 * HOUR - 60_000;
  const machineCopy: MachineCopy = {
    machineId: M1,
    info: machineInfo(M1, 'ubuntu-pc', capabilities),
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
    m1Capabilities: capabilities,
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
          tasks: [],
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

  it("without a plug that reads off, the line says it sends when it's reachable", async () => {
    const env = await start({ power: false });
    const composer = await openChat(env);
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
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(screen.getByText(WAITING_REACHABLE)).toBeTruthy();

    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    env.delivered();
    await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull());
    expect(env.remote.calls('chat.open').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText(WAITING_REACHABLE)).toBeNull());
    expect(screen.queryByText('… earlier messages are on Ubuntu PC')).toBeNull();
    // The message the machine took is in the live chat.
    expect(await screen.findByText('Postgres it is')).toBeTruthy();
  });

  it("a machine without the away capability can't queue", async () => {
    const env = await start({ capabilities: ['remote', POWER_CAPABILITY] });
    const composer = await openChat(env);
    expect(await screen.findByText("Update Ubuntu PC to send while it's off")).toBeTruthy();
    expect(composer().disabled).toBe(true);
    expect(screen.getByRole('button', { name: /^send/i })).toHaveProperty('disabled', true);
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
    expect(await screen.findByText('Ubuntu PC is off: showing the chat as it was')).toBeTruthy();
    expect(within(header).queryByRole('img', { name: 'Working' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(
      screen.getByText(
        "Claude asked this before Ubuntu PC went off. Type your answer below; it's sent as your next message.",
      ),
    ).toBeTruthy();
    // The card can't be answered: nothing goes to the machine or the queue.
    const card = screen.getByRole('group', { name: 'Permission request: Bash' });
    await userEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(queued(env)).toHaveLength(0);
    // A typed answer waits as the next message.
    await userEvent.type(composer(), 'No, keep it{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(1));
    expect(queued(env)[0]).toMatchObject({ sessionId: 'r1', kind: 'send', text: 'No, keep it' });
    expect(env.remote.calls('chat.respond')).toHaveLength(0);
    expect(env.server.calls('chat.respond')).toHaveLength(0);
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
