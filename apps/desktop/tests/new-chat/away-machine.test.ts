import {
  AWAY_CAPABILITY,
  POWER_CAPABILITY,
  PROJECTS_CAPABILITY,
  type AwayItem,
  type MachineCopy,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import type { AppState } from '../../src/lib/state/context';
import { M1, machineInfo, project, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';
import { user } from '../chat/fixtures';

vi.setConfig({ testTimeout: 20_000 });

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
const AVAILABLE = 'Available when Ubuntu PC is on';

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
});

type QueueParams = {
  machineId: string;
  sessionId: string;
  kind: 'send' | 'create';
  text: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
};

const awayItem = (over: Partial<AwayItem> = {}): AwayItem => ({
  id: 'row-1',
  machineId: M1,
  sessionId: 'new-1',
  kind: 'create',
  text: 'Set up CI',
  imageCount: 0,
  cwd: '/work/infra',
  createdAt: Date.now(),
  state: 'waiting',
  reason: null,
  error: null,
  ...over,
});

/**
 * Ubuntu PC (M1) is away: its relay refuses and its plug reads off. This
 * device keeps its copy (its projects, and its info with home `/home/jiri`)
 * and the messages waiting for it. Once the machine is on, it knows a chat
 * only after the waiting `create` was delivered (`made`).
 */
const start = async (
  o: {
    /** What the copied info says the machine can do (default: projects, power and away). */
    capabilities?: string[];
    /** `away.queue` fails with this. */
    queueFails?: RpcFail;
    /** `away.queue` fails with this the first time only (its reply lost, say). */
    queueFailsOnce?: RpcFail;
    /** The machine's `chat.open` fails with this, even once it made the chat. */
    openFails?: RpcFail;
    /** Messages already waiting. */
    waiting?: AwayItem[];
    /** `away.cancel` of this row fails (it went out meanwhile). */
    cancelFails?: string;
    /** It has power control, so its plug reads off (default). */
    power?: boolean;
  } = {},
) => {
  const capabilities = o.capabilities ?? [
    'remote',
    PROJECTS_CAPABILITY,
    POWER_CAPABILITY,
    AWAY_CAPABILITY,
  ];
  const machineCopy: MachineCopy = {
    machineId: M1,
    info: { ...machineInfo(M1, 'ubuntu-pc', capabilities), home: '/home/jiri' },
    projects: [{ ...project('p2', 'infra'), exists: true }],
    chats: [summary('r1', { projectId: 'p2', cwd: '/work/infra' })],
    copiedAt: Date.now() - 3_600_000,
  };
  let items: AwayItem[] = o.waiting ?? [];
  let failOnce = o.queueFailsOnce;
  /** The chats the machine has made from delivered `create`s. */
  const made = new Set<string>();
  const env = await setupTwoMachines({
    waitForOn: false,
    m1Capabilities: capabilities,
    powerPasswords: { [M1]: 'pw' },
    configure: (s) => {
      const changed = () => s.push('away.changed', { items, states: [] });
      Object.assign(s.handlers, {
        'power.list': () => (o.power === false ? [] : [{ machineId: M1, config: CONFIG }]),
        'power.reading': () => ({ on: false, watts: 0, at: Date.now() }),
        'power.turnOn': () => ({ cycled: false, waitMs: 0 }),
        'power.unlock': () => ({}),
        'power.noteMeasurement': () => ({}),
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => [],
        'chat.commands': () => [],
        'files.suggest': () => [],
        'copies.get': (p: unknown) =>
          (p as { machineId: string }).machineId === M1 ? machineCopy : null,
        'copies.chat': () => null,
        'away.list': () => ({ items, states: [] }),
        'away.queue': (p: unknown) => {
          if (o.queueFails) throw o.queueFails;
          if (failOnce) {
            const fail = failOnce;
            failOnce = undefined;
            throw fail;
          }
          const q = p as QueueParams;
          const row = awayItem({
            id: `row-${items.length + 1}`,
            sessionId: q.sessionId,
            kind: q.kind,
            text: q.text,
            cwd: q.cwd ?? null,
          });
          items = [...items, row];
          changed();
          return row;
        },
        'away.cancel': (p: unknown) => {
          if ((p as { id: string }).id === o.cancelFails) {
            throw new RpcFail('ALREADY_SENT', 'It went out already');
          }
          items = items.filter((i) => i.id !== (p as { id: string }).id);
          changed();
          return {};
        },
      });
    },
    configureRemote: (s) => {
      s.refuse = true;
      Object.assign(s.handlers, {
        'projects.list': () => [project('p2', 'infra')],
        'chat.open': (p: unknown) => {
          const { sessionId } = p as { sessionId: string };
          if (!made.has(sessionId)) throw new RpcFail('NOT_FOUND', 'No such chat');
          if (o.openFails) throw o.openFails;
          return {
            summary: summary(sessionId, {
              title: 'Set up CI',
              projectId: 'p2',
              cwd: '/work/infra',
              status: 'working',
              live: true,
            }),
            header: {},
            items: [user('u1', 'Set up CI')],
            hasMore: false,
            seq: 2,
            tasks: [],
          };
        },
        'chat.send': () => ({ queued: false }),
        'chat.commands': () => [],
        'chat.models': () => [],
        'files.suggest': () => [],
      });
    },
  });
  apps.push(env.app);
  /** The deliverer made the chat on the machine: the local service's list empties. */
  const delivered = (sessionId: string) => {
    made.add(sessionId);
    items = [];
    env.server.push('away.changed', { items, states: [] });
  };
  return { ...env, delivered };
};

type Env = Awaited<ReturnType<typeof start>>;

const queued = (env: Env): QueueParams[] =>
  env.server.calls('away.queue').map((c) => c.params as QueueParams);

/** Opens New chat once Ubuntu PC's copy is read, with Ubuntu PC chosen when `choose`. */
const openDialog = async (env: Env, choose = true) => {
  await waitFor(() => expect(env.app.scopes.get(M1)?.copy?.has).toBe(true));
  await waitFor(() => expect(env.app.scopes.get(M1)?.places.projects).toHaveLength(1));
  env.app.interaction.openNewChat();
  render(NewChatDialog, { context: env.context });
  const dialog = await screen.findByRole('dialog', { name: /new chat/i });
  const machine = within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;
  if (choose) await userEvent.selectOptions(machine, M1);
  return { dialog, machine };
};

const message = (dialog: HTMLElement) =>
  within(dialog).getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;

/** Writes the first message for Ubuntu PC's infra folder and sends it; resolves to the chat's id. */
const sendFirst = async (env: Env): Promise<string> => {
  const { dialog } = await openDialog(env);
  const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
  await userEvent.selectOptions(folder, '/work/infra');
  await userEvent.type(message(dialog), 'Set up CI{Enter}');
  await waitFor(() => expect(queued(env)).toHaveLength(1));
  // Sending ends when the dialog is gone: it unmounts a frame or more after it
  // closes, and gives the page its pointer back after that. Until then a click
  // in the chat is blocked, and its composer is not the only "message" box.
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
  return queued(env)[0]!.sessionId;
};

describe('a new chat on a machine that is away', () => {
  it('New chat offers an away machine with its copied folders and Home', async () => {
    const env = await start();
    const { dialog, machine } = await openDialog(env, false);
    const option = within(machine).getByRole('option', { name: 'Ubuntu PC (off)' });
    expect((option as HTMLOptionElement).disabled).toBe(false);
    await userEvent.selectOptions(machine, M1);
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    expect(within(folder).getByRole('option', { name: 'infra' })).toBeTruthy();
    const home = within(folder).getByRole('option', { name: 'Home folder' }) as HTMLOptionElement;
    expect(home.value).toBe('/home/jiri');
    // This PC's projects are not Ubuntu PC's.
    expect(within(folder).queryByRole('option', { name: 'alpha' })).toBeNull();
    // Looking never contacts it, and never turns it on.
    expect(env.remote.sent).toHaveLength(0);
    expect(env.server.calls('power.turnOn')).toHaveLength(0);
  });

  it("an away machine that can't take a message while off is shown, but can't be chosen", async () => {
    const env = await start({ capabilities: ['remote', PROJECTS_CAPABILITY, POWER_CAPABILITY] });
    const { machine } = await openDialog(env, false);
    const option = within(machine).getByRole('option', {
      name: "Ubuntu PC (off) — Update Ubuntu PC to send while it's off",
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("New project, Clone and Browse are disabled while it's away", async () => {
    const env = await start();
    const { dialog } = await openDialog(env);
    for (const name of ['New project', 'Clone']) {
      const tab = within(dialog).getByRole('tab', { name }) as HTMLButtonElement;
      expect(tab.disabled).toBe(true);
      expect(tab.getAttribute('title')).toBe(AVAILABLE);
    }
    const browse = within(dialog).getByRole('button', { name: 'Browse…' }) as HTMLButtonElement;
    expect(browse.disabled).toBe(true);
    expect(browse.getAttribute('title')).toBe(AVAILABLE);
  });

  it('sending opens the chat at once with Starting and the waiting first message', async () => {
    const env = await start();
    render(ChatPane, { context: env.context });
    const id = await sendFirst(env);
    expect(queued(env)[0]).toMatchObject({
      machineId: M1,
      sessionId: id,
      kind: 'create',
      cwd: '/work/infra',
      text: 'Set up CI',
    });
    // The id is this device's own, and the tab is keyed by it.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(env.app.tabs.active).toBe(`${M1}/${id}`));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /new chat/i })).toBeNull());

    expect(await screen.findByText('Starting Ubuntu PC…')).toBeTruthy();
    const line = await screen.findByText(WAITING_OFF);
    const row = line.closest('[data-away-item]') as HTMLElement;
    expect(within(row).getByText('Set up CI')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByText(/Could not open this chat/)).toBeNull();
    // Nothing asks the machine while it's away.
    expect(env.remote.sent).toHaveLength(0);
  });

  it('once delivered, the same tab is the live chat', async () => {
    const env = await start();
    render(ChatPane, { context: env.context });
    const id = await sendFirst(env);
    expect(await screen.findByText('Starting Ubuntu PC…')).toBeTruthy();

    // The machine comes up before the deliverer made the chat there.
    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    expect(screen.getByText('Starting Ubuntu PC…')).toBeTruthy();
    expect(screen.queryByText(/Could not open this chat/)).toBeNull();

    env.delivered(id);
    await waitFor(() => expect(screen.queryByText('Starting Ubuntu PC…')).toBeNull());
    await waitFor(() => expect(screen.queryByText(WAITING_OFF)).toBeNull());
    // The machine's own chat, with its first message in the messages.
    const messages = await screen.findByRole('region', { name: 'Messages' });
    expect(within(messages).getByText('Set up CI')).toBeTruthy();
    expect(env.remote.calls('chat.open').at(-1)!.params).toMatchObject({ sessionId: id });
    // One tab, the same one, never swapped.
    expect(env.app.tabs.open).toEqual([`${M1}/${id}`]);
    expect(env.app.tabs.active).toBe(`${M1}/${id}`);
    expect(env.app.scopes.get(M1)?.chats.get(id)?.live).toBe(true);
  });

  it("a queue that can't take the message keeps the dialog open with the text and the error", async () => {
    const env = await start({ queueFails: new RpcFail('INTERNAL', 'The disk is full') });
    const { dialog } = await openDialog(env);
    await userEvent.type(message(dialog), 'Set up CI{Enter}');
    expect(await within(dialog).findByText('The disk is full')).toBeTruthy();
    expect(message(dialog).value).toBe('Set up CI');
    expect(env.app.tabs.open).toEqual([]);
  });

  it('a tab of a chat only in the queue shows Starting after a restart', async () => {
    const env = await start({ waiting: [awayItem()] });
    env.app.tabs.openTab({ machineId: M1, sessionId: 'new-1' });
    render(ChatPane, { context: env.context });
    expect(await screen.findByText('Starting Ubuntu PC…')).toBeTruthy();
    expect(await screen.findByText(WAITING_OFF)).toBeTruthy();
    expect(screen.queryByText(/Could not open this chat/)).toBeNull();
    expect(env.remote.sent).toHaveLength(0);
  });

  it("cancelling a chat's first message before it started closes its tab", async () => {
    const env = await start();
    render(ChatPane, { context: env.context });
    const id = await sendFirst(env);
    const line = await screen.findByText(WAITING_OFF);
    const row = line.closest('[data-away-item]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(env.app.tabs.open).toEqual([]));
    expect(env.server.calls('away.cancel')[0]!.params).toEqual({ id: 'row-1' });
    expect(env.app.scopes.get(M1)?.chats.get(id)).toBeUndefined();
  });

  it('a message written before the machine made the chat waits behind its first one, even once it is connected', async () => {
    const env = await start();
    render(ChatPane, { context: env.context });
    const id = await sendFirst(env);
    expect(await screen.findByText('Starting Ubuntu PC…')).toBeTruthy();
    // No Schedule send for a chat its machine hasn't made.
    expect(screen.queryByRole('button', { name: 'More send options' })).toBeNull();

    // The machine is up, but the deliverer hasn't made the chat there yet.
    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    expect(screen.queryByRole('button', { name: 'More send options' })).toBeNull();
    const composer = screen.getByRole('textbox', { name: /message/i });
    await userEvent.type(composer, 'Add the docs too{Enter}');
    await waitFor(() => expect(queued(env)).toHaveLength(2));
    expect(queued(env)[1]).toMatchObject({
      machineId: M1,
      sessionId: id,
      kind: 'send',
      text: 'Add the docs too',
    });
    expect(env.remote.calls('chat.send')).toHaveLength(0);
    expect(env.remote.calls('chat.resumeCheck')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // Once the machine made the chat, the next message goes to it live, once.
    env.delivered(id);
    await waitFor(() => expect(screen.queryByText('Starting Ubuntu PC…')).toBeNull());
    await waitFor(() => expect(env.app.scopes.get(M1)?.chats.get(id)?.live).toBe(true));
    await userEvent.type(
      screen.getByRole('textbox', { name: /message/i }),
      'And a changelog{Enter}',
    );
    await waitFor(() => expect(env.remote.calls('chat.send')).toHaveLength(1));
    expect(env.remote.calls('chat.send')[0]!.params).toMatchObject({
      sessionId: id,
      text: 'And a changelog',
    });
    expect(queued(env)).toHaveLength(2);
  });

  it('a refused first message shows why with Retry, not Starting', async () => {
    const env = await start({
      waiting: [awayItem({ state: 'failed', reason: 'refused', error: 'No such folder' })],
    });
    env.app.tabs.openTab({ machineId: M1, sessionId: 'new-1' });
    render(ChatPane, { context: env.context });
    const line = await screen.findByText('No such folder');
    const row = line.closest('[data-away-item]') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Starting Ubuntu PC…')).toBeNull();
  });

  it('a second Send after a lost reply keeps the same chat id', async () => {
    const env = await start({ queueFailsOnce: new RpcFail('TIMEOUT', 'No answer') });
    const { dialog } = await openDialog(env);
    await userEvent.type(message(dialog), 'Set up CI{Enter}');
    expect(await within(dialog).findByText('No answer')).toBeTruthy();
    await userEvent.type(message(dialog), '{Enter}');
    await waitFor(() => expect(env.app.tabs.open).toHaveLength(1));
    const [first, second] = env.server.calls('away.queue').map((c) => c.params as QueueParams);
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(env.app.tabs.active).toBe(`${M1}/${first!.sessionId}`);
  });

  it('a second Send keeps the same chat id whenever the message waits, even while the machine still shows as on', async () => {
    const env = await start({ queueFailsOnce: new RpcFail('TIMEOUT', 'No answer') });
    await waitFor(() => expect(env.app.scopes.get(M1)?.copy?.has).toBe(true));
    // Its link closed without the machine's state following (a closed link leaves it as it was):
    // the message waits on this device all the same.
    const entry = env.app.machines.get(M1)!;
    entry.client.close();
    entry.status = 'on';
    expect(env.app.scopes.get(M1)!.api.status).not.toBe('open');
    const { dialog } = await openDialog(env);
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    await userEvent.selectOptions(folder, '/work/infra');
    await userEvent.type(message(dialog), 'Set up CI{Enter}');
    expect(await within(dialog).findByText('No answer')).toBeTruthy();
    await userEvent.type(message(dialog), '{Enter}');
    await waitFor(() => expect(env.app.tabs.open).toHaveLength(1));
    const [first, second] = queued(env);
    expect(first).toMatchObject({ kind: 'create', cwd: '/work/infra' });
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(env.app.tabs.active).toBe(`${M1}/${first!.sessionId}`);
  });

  it("a first message that can't be cancelled leaves the later ones waiting", async () => {
    const env = await start({
      cancelFails: 'row-1',
      waiting: [
        awayItem(),
        awayItem({ id: 'row-2', kind: 'send', text: 'Add the docs too', cwd: null }),
      ],
    });
    env.app.tabs.openTab({ machineId: M1, sessionId: 'new-1' });
    render(ChatPane, { context: env.context });
    await screen.findByText('Add the docs too');
    const first = document.querySelector('[data-away-item]') as HTMLElement;
    expect(within(first).getByText('Set up CI')).toBeTruthy();
    await userEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('It went out already')).toBeTruthy();
    expect(env.server.calls('away.cancel').map((c) => c.params)).toEqual([{ id: 'row-1' }]);
    expect(screen.getByText('Add the docs too')).toBeTruthy();
    expect(env.app.tabs.open).toEqual([`${M1}/new-1`]);
  });

  it("a chat its machine can't open once made says so, not Starting", async () => {
    const env = await start({ openFails: new RpcFail('INTERNAL', 'The chat log is unreadable') });
    render(ChatPane, { context: env.context });
    const id = await sendFirst(env);
    expect(await screen.findByText('Starting Ubuntu PC…')).toBeTruthy();
    env.remote.refuse = false;
    await waitFor(() => expect(env.app.machines.get(M1)?.status).toBe('on'), { timeout: 10_000 });
    env.delivered(id);
    expect(
      await screen.findByText('Could not open this chat: The chat log is unreadable'),
    ).toBeTruthy();
    expect(screen.queryByText('Starting Ubuntu PC…')).toBeNull();
  });

  it('an away machine is offered under the state it shows', async () => {
    // Without power control nothing says it's off: it shows as still connecting.
    const env = await start({ power: false });
    const { machine } = await openDialog(env, false);
    expect(env.app.machines.shown(env.app.machines.get(M1)!)).toBe('connecting');
    expect(within(machine).getByRole('option', { name: 'Ubuntu PC (connecting…)' })).toBeTruthy();
  });
});
