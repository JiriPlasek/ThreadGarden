import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  MOVE_CAPABILITY,
  POWER_CAPABILITY,
  type ChatItem,
  type GitState,
  type PowerConfig,
} from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ChatHeader from '../../src/lib/components/chat/ChatHeader.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import MoveChatDialog from '../../src/lib/components/MoveChatDialog.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import { moveNote } from '../../src/lib/move/note';
import type { AppState } from '../../src/lib/state/context';
import { user } from '../chat/fixtures';
import { LOCAL, M1, machineInfo, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const REF = { machineId: LOCAL, sessionId: 's1' };
const ORIGIN = 'https://github.com/jiri/threadgarden.git';
const CLEAN: GitState = { kind: 'clean', branch: 'main', origin: ORIGIN };
const TARGET_FOLDER = '/home/u/threadgarden';

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

type Handler = (p: unknown) => unknown;

/** What a rendered chat pane asks besides `chat.open`. */
const PANE: Record<string, Handler> = {
  'chat.commands': () => [],
  'chat.models': () => [],
  'files.suggest': () => [],
  'chat.resumeCheck': () => ({ status: 'ok', reason: '', recentlyModified: false }),
};

let apps: AppState[] = [];
beforeEach(() => {
  // bits-ui's scroll lock of a dialog left open by the previous test outlives it in jsdom.
  document.body.removeAttribute('style');
});
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
});

/**
 * This PC holds chat s1, Ubuntu PC (M1) is the other machine. Both services
 * can move chats unless `m1Move` is false; `source`/`target` add handlers.
 */
const start = async (
  o: {
    git?: GitState;
    busy?: 'turn' | 'prompt' | 'subagents' | 'terminal' | null;
    m1Move?: boolean;
    /** This PC's service can move chats (default true). */
    localMove?: boolean;
    /** M1 is off; `power`: it has power control. */
    off?: boolean;
    power?: boolean;
    source?: Record<string, Handler>;
    target?: Record<string, Handler>;
  } = {},
) => {
  const env = await setupTwoMachines({
    m1Capabilities: [
      'remote',
      ...(o.m1Move === false ? [] : [MOVE_CAPABILITY]),
      ...(o.power ? [POWER_CAPABILITY] : []),
    ],
    powerPasswords: { [M1]: 'pw' },
    waitForOn: !o.off,
    configure: (s) => {
      const hello = s.handlers['hello']!;
      s.handlers['hello'] = (p) => ({
        ...(hello(p) as object),
        machine: machineInfo(LOCAL, 'my-host', [
          'remote',
          ...(o.localMove === false ? [] : [MOVE_CAPABILITY]),
        ]),
      });
      s.handlers['sessions.list'] = () => ({ items: [summary('s1', { title: 'Fix usage' })] });
      s.handlers['power.list'] = () => (o.power ? [{ machineId: M1, config: CONFIG }] : []);
      s.handlers['power.reading'] = () => ({ on: !o.off, watts: o.off ? 0 : 60, at: Date.now() });
      s.handlers['power.unlock'] = () => ({});
      s.handlers['power.noteMeasurement'] = () => ({});
      Object.assign(s.handlers, {
        'move.check': () => ({
          cwd: 'C:\\work\\threadgarden',
          busy: o.busy ?? null,
          git: o.git ?? CLEAN,
        }),
        'move.exportBegin': (p: unknown) => ({
          exportId: (p as { exportId: string }).exportId,
          parts: 1,
          bytes: 10,
        }),
        'move.exportPart': () => ({ keys: [{ entries: [{ type: 'user' }] }] }),
        'move.abort': () => ({}),
        'move.markMoved': () => ({}),
        'scheduled.list': () => ({ items: [] }),
        'chat.send': () => ({ queued: false }),
        'chat.interrupt': () => ({}),
        'chat.end': () => ({}),
        ...PANE,
        ...o.source,
      });
    },
    configureRemote: (s) => {
      Object.assign(s.handlers, {
        'power.status': () => ({
          configured: true,
          busy: false,
          idleSince: null,
          shutsDownAt: null,
          keepAwake: { mode: 'off', until: null },
          phase: 'running',
          unpushed: [],
          problem: null,
        }),
        'power.adopt': () => ({}),
        'move.target': () => ({ folder: TARGET_FOLDER, matched: true, inUse: null }),
        'move.importPart': () => ({}),
        'move.commit': () => ({ summary: summary('s1') }),
        'chat.send': () => ({ queued: false }),
        ...PANE,
        ...o.target,
      });
      if (o.off) s.refuse = true;
    },
  });
  apps.push(env.app);
  return env;
};

/** Renders the dialog and opens it on chat s1 of `ref`'s machine (This PC's by default). */
const openDialog = async (o: Parameters<typeof start>[0] & { ref?: typeof REF } = {}) => {
  const env = await start(o);
  render(MoveChatDialog, { context: env.context });
  env.app.interaction.openMoveChat(o.ref ?? REF);
  const dialog = await screen.findByRole('dialog', { name: /move this chat/i });
  return { ...env, dialog };
};

const optionsOf = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => ({
      text: o.textContent?.trim(),
      disabled: (o as HTMLOptionElement).disabled,
    }));

/** bits-ui keeps a menu hidden while its anchor has no client rect (jsdom has no layout). */
const openMenu = async (trigger: HTMLElement): Promise<void> => {
  trigger.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
  await userEvent.click(trigger);
};

describe('Move to… entry points', () => {
  it('Move to… appears in the header menu, the row menu and Ctrl+K', async () => {
    const { app, context } = await start();

    // The chat header's Chat state menu.
    await app.chats.open('s1');
    const header = render(ChatHeader, { context, props: { chat: app.chats.get('s1')! } });
    await openMenu(screen.getByRole('button', { name: 'Chat state' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    expect(app.interaction.moveChat).toMatchObject({ open: true, ref: REF });
    header.unmount();
    app.interaction.closeMoveChat();

    // The chat row's menu.
    const list = render(ChatList, { context });
    const row = await screen.findByRole('option', { name: /Fix usage/ });
    await fireEvent.contextMenu(row);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    expect(app.interaction.moveChat).toMatchObject({ open: true, ref: REF });
    // The row's summary comes along: the dialog names a chat that is not open.
    expect(app.interaction.moveChat.summary?.title).toBe('Fix usage');
    list.unmount();
    app.interaction.closeMoveChat();

    // Ctrl/Cmd+K, for the active tab's chat.
    app.tabs.openTab(REF);
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox'), 'move');
    await userEvent.click(await screen.findByRole('option', { name: /Move to…/ }));
    expect(app.interaction.moveChat).toMatchObject({ open: true, ref: REF });
    expect(app.interaction.moveChat.summary?.sessionId).toBe('s1');
  });

  it("no Move to… for a chat whose own machine's service can't move it", async () => {
    const { app, context } = await start({ localMove: false });

    await app.chats.open('s1');
    const header = render(ChatHeader, { context, props: { chat: app.chats.get('s1')! } });
    await openMenu(screen.getByRole('button', { name: 'Chat state' }));
    expect(await screen.findAllByRole('menuitem', { name: /Archive|Put on hold/ })).not.toEqual([]);
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).toBeNull();
    header.unmount();

    const list = render(ChatList, { context });
    await fireEvent.contextMenu(await screen.findByRole('option', { name: /Fix usage/ }));
    expect(await screen.findAllByRole('menuitem', { name: /Pin|Rename/ })).not.toEqual([]);
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).toBeNull();
    list.unmount();

    app.tabs.openTab(REF);
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox'), 'move');
    expect(screen.queryByRole('option', { name: /Move to…/ })).toBeNull();
  });
});

describe('the Move dialog', () => {
  it("the target list leaves out the chat's machine and disables one without move", async () => {
    const { dialog } = await openDialog({ m1Move: false });
    const select = within(dialog).getByRole('combobox', { name: 'Machine' });
    expect(optionsOf(select)).toEqual([{ text: 'Ubuntu PC', disabled: true }]);
    expect(within(dialog).getByText('Update Ubuntu PC to move chats there')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('a chat on Ubuntu PC offers This PC as a target', async () => {
    const { dialog } = await openDialog({
      ref: { machineId: M1, sessionId: 's1' },
      target: {
        'move.check': () => ({ cwd: '/home/u/threadgarden', busy: null, git: CLEAN }),
      },
      source: {
        'move.target': () => ({ folder: 'C:\\work\\threadgarden', matched: true, inUse: null }),
      },
    });
    const select = within(dialog).getByRole('combobox', { name: 'Machine' });
    expect(optionsOf(select)).toEqual([{ text: 'This PC', disabled: false }]);
    expect(await within(dialog).findByText('C:\\work\\threadgarden')).toBeTruthy();
  });

  it('names a chat that is not open from the summary it was opened with', async () => {
    const env = await start();
    render(MoveChatDialog, { context: env.context });
    env.app.interaction.openMoveChat(REF, summary('s1', { title: 'Fix usage' }));
    const dialog = await screen.findByRole('dialog', { name: /move this chat/i });
    expect(within(dialog).getByText(/Fix usage/)).toBeTruthy();
  });

  it('an Off machine with power control will be started; one without is off', async () => {
    const { dialog } = await openDialog({ off: true, power: true });
    const select = within(dialog).getByRole('combobox', { name: 'Machine' });
    await waitFor(() =>
      expect(optionsOf(select)).toEqual([
        { text: 'Ubuntu PC (off, it will be started)', disabled: false },
      ]),
    );
  });

  it('a machine without power control that is off is listed disabled', async () => {
    const { dialog } = await openDialog({ off: true });
    const select = within(dialog).getByRole('combobox', { name: 'Machine' });
    await waitFor(() =>
      expect(optionsOf(select)).toEqual([{ text: 'Ubuntu PC (off)', disabled: true }]),
    );
  });

  it('a clean chat moves with Move: the checks, then Moved to Ubuntu PC', async () => {
    const { dialog, remote, app } = await openDialog();
    app.tabs.openTab(REF);
    expect(await within(dialog).findByText(TARGET_FOLDER)).toBeTruthy();
    expect(within(dialog).getByText(/nothing stays behind/i)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText('Moved to Ubuntu PC')).toBeTruthy();
    expect(remote.calls('move.commit')[0]!.params).toMatchObject({ cwd: TARGET_FOLDER });
    expect(app.tabs.active).toBe(`${M1}/s1`);
  });

  it('dirty project shows the counts and the three choices', async () => {
    const { dialog, server, app } = await openDialog({
      git: { kind: 'dirty', branch: 'fix/usage', origin: ORIGIN, changed: 3, unpushed: 2 },
    });
    expect(
      await within(dialog).findByText('3 changed files · 2 commits not pushed on fix/usage'),
    ).toBeTruthy();
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => t && !/browse|close/i.test(t));
    expect(buttons).toEqual(['Ask Claude to commit and push', 'Move anyway', 'Cancel']);

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Ask Claude to commit and push' }),
    );
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(server.calls('chat.send')[0]!.params).toMatchObject({ sessionId: 's1' });
    expect((server.calls('chat.send')[0]!.params as { text: string }).text).toContain('fix/usage');
    await waitFor(() => expect(app.interaction.moveChat.open).toBe(false));
  });

  it('notRepo shows the files-stay text and no push choice', async () => {
    const { dialog, remote } = await openDialog({ git: { kind: 'notRepo' } });
    expect(
      await within(dialog).findByText("This folder isn't a git repo; its files stay on This PC"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole('button', { name: 'Ask Claude to commit and push' }),
    ).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move anyway' }));
    await waitFor(() => expect(remote.calls('move.commit')).toHaveLength(1));
  });

  it('busy chat offers Stop the chat', async () => {
    let busy: 'turn' | null = 'turn';
    const { dialog, server } = await openDialog({
      source: {
        'move.check': () => ({ cwd: 'C:\\work\\threadgarden', busy, git: CLEAN }),
        'chat.interrupt': () => {
          busy = null;
          return {};
        },
      },
    });
    expect(await within(dialog).findByText(/Claude is working in this chat/)).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop the chat' }));
    await waitFor(() => expect(server.calls('chat.interrupt')).toHaveLength(1));
    expect(server.calls('chat.interrupt')[0]!.params).toEqual({ sessionId: 's1' });
    // Checked again once stopped: the chat can move.
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(within(dialog).queryByText(/Claude is working in this chat/)).toBeNull();
  });

  it('background agents: Stop the chat ends it (an interrupt would leave them running)', async () => {
    const { dialog, server } = await openDialog({ busy: 'subagents' });
    expect(await within(dialog).findByText(/Background agents are running/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop the chat' }));
    await waitFor(() => expect(server.calls('chat.end')).toHaveLength(1));
    expect(server.calls('chat.end')[0]!.params).toEqual({ sessionId: 's1' });
    expect(server.calls('chat.interrupt')).toHaveLength(0);
  });

  it('a chat running in a terminal says so and cannot move', async () => {
    const { dialog } = await openDialog({ busy: 'terminal' });
    expect(await within(dialog).findByText('This chat is running in a terminal')).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Threadgarden can't stop a terminal's process.
    expect(within(dialog).queryByRole('button', { name: 'Stop the chat' })).toBeNull();
  });

  it('a stop that fails says so in the dialog', async () => {
    const { dialog } = await openDialog({
      busy: 'turn',
      source: {
        'chat.interrupt': () => {
          throw new RpcFail('NOT_LIVE', 'Chat s1 is not running');
        },
      },
    });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Stop the chat' }));
    expect(await within(dialog).findByText('Chat s1 is not running')).toBeTruthy();
  });

  it('Cancel is offered until the commit is sent, not after', async () => {
    const held: Record<string, () => void> = {};
    const hold = (name: string, answer: unknown) => () =>
      new Promise((resolve) => (held[name] = () => resolve(answer)));
    const { dialog, remote } = await openDialog({
      source: { 'move.exportBegin': hold('begin', { exportId: 'x', parts: 1, bytes: 10 }) },
      target: { 'move.commit': hold('commit', { summary: summary('s1') }) },
    });
    // Before the commit: the move can be given up.
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    await waitFor(() => expect(held['begin']).toBeDefined());
    expect(within(dialog).getByText('Moving…')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    held['begin']!();
    // The commit is out: Cancel would do nothing, so it is gone.
    await waitFor(() => expect(remote.calls('move.commit')).toHaveLength(1));
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull(),
    );
    expect(within(dialog).getByText('Moving…')).toBeTruthy();
    held['commit']!();
    expect(await within(dialog).findByText('Moved to Ubuntu PC')).toBeTruthy();
  });

  it('inUse warning text', async () => {
    const { dialog } = await openDialog({
      target: {
        'move.target': () => ({
          folder: TARGET_FOLDER,
          matched: true,
          inUse: { branch: 'main', running: 1 },
        }),
      },
    });
    expect(
      await within(dialog).findByText(
        "Ubuntu PC's threadgarden is on main; 1 chat is running there",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Move anyway' })).toBeTruthy();
  });

  it('inUse with an unknown branch and several chats', async () => {
    const { dialog } = await openDialog({
      target: {
        'move.target': () => ({
          folder: TARGET_FOLDER,
          matched: true,
          inUse: { branch: null, running: 2 },
        }),
      },
    });
    expect(
      await within(dialog).findByText(
        "Ubuntu PC's threadgarden is on another branch; 2 chats are running there",
      ),
    ).toBeTruthy();
  });

  it('a failed markMoved says the old copy is still shown, with Retry', async () => {
    let fails = true;
    const { dialog, server } = await openDialog({
      source: {
        'move.markMoved': () => {
          if (fails) throw new RpcFail('INTERNAL', 'db locked');
          return {};
        },
      },
    });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText('The old copy on This PC is still shown')).toBeTruthy();
    fails = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(dialog).queryByText('The old copy on This PC is still shown')).toBeNull(),
    );
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(server.calls('move.markMoved')).toHaveLength(2);
  });

  it('a failed first note offers Send again', async () => {
    let fails = true;
    const { dialog, remote } = await openDialog({
      target: {
        'chat.send': () => {
          if (fails) throw new RpcFail('INTERNAL', 'Claude Code is not ready');
          return { queued: false };
        },
      },
    });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText(/Claude Code is not ready/)).toBeTruthy();
    fails = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(remote.calls('chat.send')).toHaveLength(2));
    await waitFor(() => expect(within(dialog).queryByText(/Claude Code is not ready/)).toBeNull());
  });

  it('Starting Ubuntu PC… with Cancel while an Off target comes up', async () => {
    const { dialog, server } = await openDialog({
      off: true,
      power: true,
      source: { 'power.turnOn': () => ({ cycled: false, waitMs: 0 }) },
    });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText('Starting Ubuntu PC…')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByText('Move cancelled')).toBeTruthy();
    expect(server.calls('move.exportBegin')).toHaveLength(0);
  });
});

describe('the moved copy', () => {
  it('a failed first note shows in the chat on the target, also once the dialog is closed', async () => {
    let fails = true;
    const { dialog, remote, app, context } = await openDialog({
      target: {
        'chat.send': () => {
          if (fails) throw new RpcFail('INTERNAL', 'Claude Code is not ready');
          return { queued: false };
        },
      },
    });
    app.tabs.openTab(REF);
    render(ChatPane, { context });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText(/Claude Code is not ready/)).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The tab followed the chat to Ubuntu PC, and the chat says the note didn't go.
    expect(app.tabs.active).toBe(`${M1}/s1`);
    const notice = await screen.findByRole('alert', { name: /first note/ });
    expect(notice.textContent).toContain(
      "Claude's first note on Ubuntu PC didn't send: Claude Code is not ready",
    );
    fails = false;
    await userEvent.click(within(notice).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(remote.calls('chat.send')).toHaveLength(2));
    const [first, again] = remote.calls('chat.send').map((c) => c.params as { text: string });
    expect(again!.text).toBe(first!.text);
    expect(again!.text).toMatch(/^\[Threadgarden\] This chat moved from This PC to Ubuntu PC\./);
    await waitFor(() => expect(screen.queryByRole('alert', { name: /first note/ })).toBeNull());
    expect(app.interaction.pendingNotes).toEqual({});
  });

  it('the old copy still shown stays in the chat on the target once the dialog is closed, with Retry', async () => {
    let fails = true;
    const { dialog, server, app, context } = await openDialog({
      source: {
        'move.markMoved': () => {
          if (fails) throw new RpcFail('INTERNAL', 'db locked');
          return {};
        },
      },
    });
    app.tabs.openTab(REF);
    render(ChatPane, { context });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText('The old copy on This PC is still shown')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(app.tabs.active).toBe(`${M1}/s1`);
    const notice = await screen.findByRole('alert', { name: /old copy/ });
    expect(notice.textContent).toContain('The old copy on This PC is still shown');
    fails = false;
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert', { name: /old copy/ })).toBeNull());
    expect(server.calls('move.markMoved')).toHaveLength(2);
    expect(server.calls('move.markMoved')[1]!.params).toEqual(
      server.calls('move.markMoved')[0]!.params,
    );
    expect(app.interaction.pendingMarks).toEqual({});
  });

  const chatOpen =
    (over: { movedTo?: { machineId: string; name: string }; items?: ChatItem[] }) =>
    (p: unknown) => ({
      summary: summary((p as { sessionId: string }).sessionId, { title: 'Fix usage' }),
      header: {},
      items: over.items ?? [],
      hasMore: false,
      seq: 1,
      ...(over.movedTo ? { movedTo: over.movedTo } : {}),
    });

  const renderChat = async (
    open: ReturnType<typeof chatOpen>,
    configure: (s: FakeServer) => void = () => {},
  ) => {
    const env = await setupTwoMachines({
      configure: (s) => {
        s.handlers['chat.open'] = open;
        Object.assign(s.handlers, {
          'chat.commands': () => [],
          'chat.models': () => [],
          'files.suggest': () => [],
        });
        configure(s);
      },
    });
    env.app.tabs.openTab(REF);
    render(ChatPane, { context: env.context });
    await waitFor(() => expect(env.app.chats.get('s1')?.loaded).toBe(true));
    return env;
  };

  it('an away chat shows Moved to Ubuntu PC with a link and no composer', async () => {
    // The stored name is the other machine's point of view: never shown.
    const { app } = await renderChat(chatOpen({ movedTo: { machineId: M1, name: 'This PC' } }));
    const banner = await screen.findByRole('status', { name: 'Moved to Ubuntu PC' });
    expect(within(banner).getByText('Moved to Ubuntu PC')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
    await userEvent.click(within(banner).getByRole('button', { name: 'Open it on Ubuntu PC' }));
    expect(app.tabs.active).toBe(`${M1}/s1`);
  });

  it('keys in an away chat (no composer) do nothing harmful', async () => {
    await renderChat(chatOpen({ movedTo: { machineId: M1, name: 'This PC' } }));
    const banner = await screen.findByRole('status', { name: 'Moved to Ubuntu PC' });
    within(banner).getByRole('button', { name: 'Open it on Ubuntu PC' }).focus();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Control>}.{/Control}');
    await userEvent.keyboard('{Control>}.{/Control}');
    expect(screen.getByRole('status', { name: 'Moved to Ubuntu PC' })).toBeTruthy();
  });

  it('a [Threadgarden] note shows Sent by Threadgarden', async () => {
    const note = moveNote({
      from: 'Ubuntu PC',
      to: 'This PC',
      folder: 'C:\\work\\threadgarden',
      origin: ORIGIN,
      branch: 'main',
      leftBehind: null,
      inUse: false,
    });
    await renderChat(chatOpen({ items: [user('u1', note), user('u2', 'carry on please')] }));
    expect(await screen.findByText(/This chat moved from Ubuntu PC to This PC/)).toBeTruthy();
    expect(screen.getAllByText('Sent by Threadgarden')).toHaveLength(1);
    expect(screen.getByText('carry on please')).toBeTruthy();
    // Only the owner's message can be forked (a moved chat refuses forks anyway, R5).
    expect(screen.getAllByRole('button', { name: 'Fork from this message' })).toHaveLength(1);
  });
});
