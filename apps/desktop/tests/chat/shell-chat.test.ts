import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  AWAY_CAPABILITY,
  POWER_CAPABILITY,
  SHELL_CAPABILITY,
  type ChatCopy,
  type MachineCopy,
  type PowerConfig,
  type ShellRun,
} from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import type { AppState } from '../../src/lib/state/context';
import { M1, machineInfo, project, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';
import { terms } from './fake-xterm';
import { user } from './fixtures';
import { renderChat } from './mcp-harness';

vi.mock('@xterm/xterm', () => import('./fake-xterm'));
vi.mock('@xterm/addon-fit', () => import('./fake-xterm'));

const SHELL = ['remote', SHELL_CAPABILITY];

const run = (over: Partial<ShellRun> = {}): ShellRun => ({
  runId: 'r1',
  sessionId: 's1',
  command: 'ls -la',
  cwd: '/work/alpha',
  cols: 100,
  rows: 24,
  startedAt: Date.now(),
  state: 'running',
  ...over,
});

const field = () => screen.getByRole('textbox', { name: /message/i }) as HTMLDivElement;
const block = () => screen.queryByRole('group', { name: 'Command output' });

afterEach(() => {
  terms.length = 0;
});

describe('! in a Claude chat starts a command through the resume check', () => {
  const started = (s: { handlers: Record<string, (p: unknown) => unknown> }) => {
    s.handlers['shell.start'] = () => run();
  };

  it('unverified asks first', async () => {
    const env = await renderChat({
      live: false,
      capabilities: SHELL,
      resumeCheck: { status: 'unverified', reason: 'no lock', recentlyModified: false },
      configure: started,
    });
    await userEvent.type(field(), '! ls -la{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Continue this chat here?');
    expect(env.server.calls('shell.start')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue here' }));
    await waitFor(() => expect(env.server.calls('shell.start')).toHaveLength(1));
    expect(env.server.calls('shell.start')[0]!.params).toEqual({
      sessionId: 's1',
      command: 'ls -la',
      cols: 100,
      rows: 24,
    });
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('blocked shows the blocked banner', async () => {
    const env = await renderChat({
      live: false,
      capabilities: SHELL,
      resumeCheck: { status: 'blocked', reason: 'Running in pid 4242.', recentlyModified: false },
      configure: started,
    });
    await userEvent.type(field(), '! ls -la{Enter}');
    expect(await screen.findByText(/This chat can't be continued here/)).toBeTruthy();
    expect(screen.getByText(/Running in pid 4242/)).toBeTruthy();
    expect(env.server.calls('shell.start')).toHaveLength(0);
    expect(field().textContent).toBe('! ls -la');
  });

  it("ok calls shell.start with the chat's id, and the box clears", async () => {
    const env = await renderChat({ live: false, capabilities: SHELL, configure: started });
    await userEvent.type(field(), '! ls -la{Enter}');
    await waitFor(() => expect(env.server.calls('shell.start')).toHaveLength(1));
    expect(env.server.calls('chat.resumeCheck')).toHaveLength(1);
    expect(env.server.calls('shell.start')[0]!.params).toMatchObject({
      sessionId: 's1',
      command: 'ls -la',
    });
    await waitFor(() => expect(field().textContent).toBe(''));
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('a refusal from the service shows as the notice', async () => {
    await renderChat({
      capabilities: SHELL,
      configure: (s) => {
        s.handlers['shell.start'] = () => {
          throw new RpcFail('BAD_REQUEST', '! commands are for Claude chats');
        };
      },
    });
    await userEvent.type(field(), '! ls{Enter}');
    expect(
      (await screen.findByRole('status', { name: 'Command notice' })).textContent?.trim(),
    ).toBe('! commands are for Claude chats');
    expect(field().textContent).toBe('! ls');
  });
});

describe('! commands in the chat', () => {
  it('! in a Codex chat is sent as a message', async () => {
    const env = await renderChat({ sessionId: 'codex-1', capabilities: SHELL });
    await userEvent.type(field(), '! ls{Enter}');
    await waitFor(() => expect(env.server.calls('chat.send')).toHaveLength(1));
    expect(env.server.calls('chat.send')[0]!.params).toMatchObject({ text: '! ls' });
    expect(env.server.calls('shell.start')).toHaveLength(0);
    expect(field().closest('[data-command-mode]')).toBeNull();
  });

  it('an old machine says to update it', async () => {
    const env = await renderChat({ capabilities: ['remote'] });
    await userEvent.type(field(), '! ls{Enter}');
    expect(
      (await screen.findByRole('status', { name: 'Command notice' })).textContent?.trim(),
    ).toBe('Update This PC to run ! commands here.');
    expect(env.server.calls('shell.start')).toHaveLength(0);
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('the block appears and Stop stops it', async () => {
    const env = await renderChat({
      capabilities: SHELL,
      configure: (s) => {
        s.handlers['shell.start'] = () => run();
        s.handlers['shell.stop'] = () => ({});
      },
    });
    // The chat has no messages yet: the block is its first row.
    expect(screen.getByText('No messages yet.')).toBeTruthy();
    await userEvent.type(field(), '! ls -la{Enter}');
    await waitFor(() => expect(block()).not.toBeNull());
    expect(within(block()!).getByText('! ls -la · This PC · /work/alpha')).toBeTruthy();
    // The starter's block takes focus.
    await waitFor(() => expect(terms.at(-1)?.focused).toBe(true));

    env.server.push('shell.output', {
      runId: 'r1',
      sessionId: 's1',
      offset: 0,
      data: 'total 0\r\n',
    });
    await waitFor(() => expect(terms.at(-1)?.written).toContain('total 0'));

    await userEvent.click(within(block()!).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(env.server.calls('shell.stop')).toHaveLength(1));
    expect(env.server.calls('shell.stop')[0]!.params).toEqual({ runId: 'r1' });
    expect(within(block()!).getByRole('button', { name: 'Stopping…' })).toBeTruthy();

    env.server.push(
      'shell.run',
      run({ state: 'ended', endedAt: Date.now(), endReason: 'stopped' }),
    );
    await waitFor(() => expect(within(block()!).queryByRole('button')).toBeNull());
    expect(block()!.textContent).toContain('Stopped');
  });

  it('the chat counts as running while the command runs', async () => {
    const env = await renderChat({
      capabilities: SHELL,
      configure: (s) => {
        s.handlers['shell.start'] = () => run();
      },
    });
    env.app.settings.setActivityOpen(true);
    const panel = await screen.findByRole('region', { name: 'Activity' });
    expect(within(panel).queryByText('1 running')).toBeNull();
    await userEvent.type(field(), '! sleep 60{Enter}');
    await waitFor(() => expect(within(panel).getByText('1 running')).toBeTruthy());
    env.server.push('shell.run', run({ state: 'ended', endedAt: Date.now(), exitCode: 0 }));
    await waitFor(() => expect(within(panel).queryByText('1 running')).toBeNull());
  });
});

describe('a machine that is away', () => {
  const CONFIG: PowerConfig = {
    kind: 'tasmota-zigbee',
    address: '192.168.1.9',
    device: 'PC plug',
    offWatts: 5,
    minOffSeconds: 90,
    measured: { running: null, standby: null },
  };
  let apps: AppState[] = [];
  afterEach(() => {
    for (const app of apps) app.power.stop();
    apps = [];
  });

  it('an away machine says it is off', async () => {
    const capabilities = ['remote', POWER_CAPABILITY, AWAY_CAPABILITY, SHELL_CAPABILITY];
    const r1 = summary('r1', { title: 'Fix the build', projectId: 'p2', cwd: '/work/infra' });
    const copiedAt = Date.now() - 60_000;
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
      items: [user('u1', 'Why is CI red?')],
      copiedAt,
    };
    const env = await setupTwoMachines({
      waitForOn: false,
      m1Capabilities: capabilities,
      powerPasswords: { [M1]: 'pw' },
      configure: (s) => {
        Object.assign(s.handlers, {
          'power.list': () => [{ machineId: M1, config: CONFIG }],
          'power.reading': () => ({ on: false, watts: 0, at: Date.now() }),
          'power.unlock': () => ({}),
          'power.noteMeasurement': () => ({}),
          'copies.get': (p: unknown) =>
            (p as { machineId: string }).machineId === M1 ? machineCopy : null,
          'copies.chat': (p: unknown) =>
            (p as { sessionId: string }).sessionId === 'r1' ? chatCopy : null,
          'away.list': () => ({ items: [], states: [] }),
        });
      },
      configureRemote: (s) => {
        s.refuse = true;
      },
    });
    apps.push(env.app);
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
    render(ChatPane, { context: env.context });
    await waitFor(() => expect(env.app.scopes.get(M1)?.chats.get('r1')?.loaded).toBe(true));
    await screen.findByText(/Ubuntu PC is off: showing its last few messages/);
    await userEvent.type(field(), '! ls{Enter}');
    expect(
      (await screen.findByRole('status', { name: 'Command notice' })).textContent?.trim(),
    ).toBe("Ubuntu PC is off, so the command can't run there.");
    expect(env.server.calls('away.queue')).toHaveLength(0);
  });
});
