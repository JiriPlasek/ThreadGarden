import {
  RELAY_CLOSE,
  type ScheduledSend,
  type UsageAccount,
  type UsageState,
  type UsageWindow,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import UsageDialog from '../../src/lib/components/UsageDialog.svelte';
import { clockTime } from '../../src/lib/format/usage';
import { APP_CONTEXT } from '../../src/lib/state/context';
import { UsageStore } from '../../src/lib/state/usage.svelte';
import { groupUsage, type UsageMachine } from '../../src/lib/usage/accounts';
import { SID, fill, renderChat } from '../interaction/helpers';
import { M1, setup, setupTwoMachines, summary } from '../layout/harness';

const HOUR = 3_600_000;

const usageState = (over: Partial<UsageState> = {}): UsageState => ({
  windows: [
    {
      key: 'five_hour',
      status: 'allowed',
      utilization: 42,
      resetsAt: Date.now() + 2 * HOUR,
      observedAt: Date.now() - 150_000,
      source: 'event',
    },
    {
      key: 'seven_day',
      utilization: 23,
      resetsAt: Date.now() + 80 * HOUR,
      observedAt: Date.now(),
      source: 'usage',
    },
  ],
  refused: [],
  ...over,
});

const send = (over: Partial<ScheduledSend> = {}): ScheduledSend => ({
  id: 'x1',
  sessionId: SID,
  text: 'Continue with step 3',
  imageCount: 0,
  sendAt: Date.now() + HOUR,
  createdAt: Date.now(),
  state: 'pending',
  afterLimitReset: false,
  rescheduled: false,
  ...over,
});

describe('usage meter and dialog', () => {
  it('the meter is hidden while nothing is known, then shows the 5-hour window', async () => {
    const { server, context } = await setup((s) => {
      s.handlers['usage.get'] = () => ({ windows: [], refused: [] });
    });
    render(AgentsStrip, { context });
    await screen.findByRole('button', { name: /stop all work/i });
    expect(screen.queryByRole('button', { name: /^usage/i })).toBeNull();

    const state = usageState();
    server.push('usage.changed', state);
    const meter = await screen.findByRole('button', { name: /^usage/i });
    expect(meter.textContent).toContain('42%');
    expect(meter.title).toContain(clockTime(state.windows[0]!.resetsAt!));
    expect(meter.getAttribute('data-usage-status')).toBe('allowed');

    const warn = usageState();
    warn.windows[0] = { ...warn.windows[0]!, status: 'allowed_warning', utilization: 85 };
    server.push('usage.changed', warn);
    await waitFor(() => expect(meter.getAttribute('data-usage-status')).toBe('allowed_warning'));

    const limited = usageState();
    limited.windows[0] = { ...limited.windows[0]!, status: 'rejected', utilization: 100 };
    server.push('usage.changed', limited);
    await waitFor(() => expect(meter.textContent).toContain('Limit reached'));
  });

  it('clicking the meter opens Usage, which asks for a fresh reading', async () => {
    const { server, context } = await setup((s) => {
      s.handlers['usage.get'] = (p) =>
        (p as { refresh?: boolean }).refresh
          ? usageState({ subscriptionType: 'max', rateLimitsAvailable: true })
          : usageState();
    });
    render(AgentsStrip, { context });
    render(UsageDialog, { context });
    await userEvent.click(await screen.findByRole('button', { name: /^usage/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    await waitFor(() => expect(dialog.textContent).toContain('Max plan'));
    expect(server.calls('usage.get').some((c) => (c.params as { refresh?: boolean }).refresh)).toBe(
      true,
    );
    const meters = within(dialog).getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      '5-hour limit used',
      'Weekly limit used',
    ]);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('42');
    expect(dialog.textContent).toMatch(/resets in 1 h 59 min|resets in 2 h/);
    expect(dialog.textContent).toContain('seen 2 min ago');
  });

  it('says when plan limits do not apply', async () => {
    const { app, context } = await setup((s) => {
      s.handlers['usage.get'] = () => ({ windows: [], refused: [], rateLimitsAvailable: false });
    });
    render(UsageDialog, { context });
    app.usageAccounts.open();
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    await waitFor(() => expect(dialog.textContent).toMatch(/do not apply/));
  });

  it('"Usage" in Ctrl/Cmd+K opens the dialog', async () => {
    const { app, context } = await setup((s) => {
      s.handlers['usage.get'] = () => usageState();
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('combobox', { name: /search chats/i });
    await userEvent.keyboard('usage{Enter}');
    expect(app.usageAccounts.dialogOpen).toBe(true);
  });
});

describe('usage per machine', () => {
  const KEY = `threadgarden.usage.${M1}`;

  it('forget() stops the reset timer and removes the kept copy', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      localStorage.setItem(KEY, JSON.stringify(usageState()));
      const store = new UsageStore({ remember: M1 });
      expect(vi.getTimerCount()).toBe(1);
      store.forget();
      expect(vi.getTimerCount()).toBe(0);
      expect(localStorage.getItem(KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a remote store restores its last state from localStorage and keeps it after disconnect', async () => {
    const saved = usageState({ account: { email: 'me@x.cz', kind: 'login' } });
    localStorage.setItem(KEY, JSON.stringify(saved));
    expect(new UsageStore({ remember: M1 }).value).toEqual(saved);

    const fresh = usageState({ account: { email: 'me@x.cz', plan: 'max', kind: 'login' } });
    fresh.windows[0]!.utilization = 77;
    const { app, remote } = await setupTwoMachines({
      configureRemote: (s) => {
        s.handlers['usage.get'] = () => fresh;
      },
    });
    const store = app.scopes.get(M1)!.usage;
    await vi.waitFor(() => expect(store.value).toEqual(fresh));
    expect(store.connected).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(fresh);

    remote.drop(RELAY_CLOSE.unreachable);
    await vi.waitFor(() => expect(store.connected).toBe(false));
    expect(store.value).toEqual(fresh);
    // The next start begins from it.
    expect(new UsageStore({ remember: M1 }).value).toEqual(fresh);
  });

  it('the account entries follow every machine, named as the app names them', async () => {
    const me = usageState({ account: { email: 'me@x.cz', kind: 'login' } });
    const { app, remote } = await setupTwoMachines({
      configure: (s) => {
        s.handlers['usage.get'] = () => me;
      },
      configureRemote: (s) => {
        s.handlers['usage.get'] = () => me;
      },
    });
    await vi.waitFor(() =>
      expect(app.usageAccounts.entries.map((e) => [e.key, e.machines.map((m) => m.name)])).toEqual([
        ['email:me@x.cz', ['This PC', 'Ubuntu PC']],
      ]),
    );

    remote.push('usage.changed', usageState({ account: { email: 'work@y.cz', kind: 'login' } }));
    await vi.waitFor(() =>
      expect(app.usageAccounts.entries.map((e) => [e.key, e.machines.map((m) => m.name)])).toEqual([
        ['email:me@x.cz', ['This PC']],
        ['email:work@y.cz', ['Ubuntu PC']],
      ]),
    );
  });
});

describe('limit notice and scheduled sends in a chat', () => {
  it('a refused chat shows the notice and sends when the limit resets', async () => {
    const reset = Date.now() + HOUR;
    const created: unknown[] = [];
    const { composer, server } = await renderChat({
      configure: (s) => {
        s.handlers['usage.get'] = () =>
          usageState({
            windows: [
              {
                key: 'five_hour',
                status: 'rejected',
                resetsAt: reset,
                observedAt: Date.now(),
                source: 'event',
              },
            ],
            refused: [{ sessionId: SID, at: Date.now(), resetsAt: reset }],
          });
        s.handlers['scheduled.list'] = () => ({ items: [] });
        s.handlers['scheduled.create'] = (p) => {
          created.push(p);
          return send({ afterLimitReset: true, sendAt: reset + 30_000 });
        };
      },
    });
    const notice = await screen.findByText(`Usage limit reached — resets at ${clockTime(reset)}`);
    expect(notice).toBeTruthy();
    await fill(composer(), 'Carry on');
    await userEvent.click(screen.getByRole('button', { name: /send when the limit resets/i }));
    await waitFor(() =>
      expect(created).toEqual([{ sessionId: SID, text: 'Carry on', whenLimitResets: true }]),
    );
    await waitFor(() => expect(composer().textContent).toBe(''));
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('Schedule send… from the send button menu, in 1 hour', async () => {
    const created: { sendAt?: number }[] = [];
    const { composer } = await renderChat({
      configure: (s) => {
        s.handlers['usage.get'] = () => usageState();
        s.handlers['scheduled.list'] = () => ({ items: [] });
        s.handlers['scheduled.create'] = (p) => {
          created.push(p as { sendAt?: number });
          return send();
        };
      },
    });
    // Not limited: no "Send when the limit resets".
    expect(screen.queryByRole('button', { name: /send when the limit resets/i })).toBeNull();
    await fill(composer(), 'Later please');
    const more = screen.getByRole('button', { name: /more send options/i });
    // jsdom has no layout: bits-ui keeps a menu hidden while its anchor has no rect.
    more.getClientRects = () => [new DOMRect(0, 0, 16, 28)] as unknown as DOMRectList;
    await userEvent.click(more);
    await userEvent.click(await screen.findByRole('menuitem', { name: /schedule send/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule send' });
    // Without a known reset, the preset is in 1 hour.
    expect(within(dialog).queryByLabelText(/when the limit resets/i)).toBeNull();
    expect((within(dialog).getByLabelText(/in 1 hour/i) as HTMLInputElement).checked).toBe(true);
    const before = Date.now();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.sendAt).toBeGreaterThanOrEqual(before + HOUR - 1000);
    await waitFor(() => expect(composer().textContent).toBe(''));
  });

  it('lists the chat’s scheduled sends: Send now, Cancel and Edit', async () => {
    let items = [send(), send({ id: 'x2', text: 'Second', state: 'failed', error: 'Blocked' })];
    const calls: string[] = [];
    const { composer, server } = await renderChat({
      configure: (s) => {
        s.handlers['usage.get'] = () => usageState();
        s.handlers['scheduled.list'] = () => ({ items });
        s.handlers['scheduled.sendNow'] = (p) => (
          calls.push(`now ${(p as { id: string }).id}`),
          {}
        );
        s.handlers['scheduled.cancel'] = (p) => (
          calls.push(`cancel ${(p as { id: string }).id}`),
          {}
        );
        s.handlers['scheduled.get'] = () => ({
          ...send(),
          images: [],
        });
        s.handlers['scheduled.update'] = (p) => {
          calls.push(`update ${JSON.stringify(p)}`);
          return send({ text: (p as { text: string }).text });
        };
      },
    });
    const list = await screen.findByRole('region', { name: 'Scheduled messages' });
    expect(list.textContent).toContain('Continue with step 3');
    expect(within(list).getByRole('alert').textContent).toBe('Blocked');
    const rows = within(list).getAllByRole('listitem');
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Send now' }));
    await userEvent.click(within(rows[1]!).getByRole('button', { name: /cancel scheduled/i }));
    await waitFor(() => expect(calls).toEqual(['now x2', 'cancel x2']));

    // Edit: back into the composer, saved with Save; what was typed before comes back.
    await fill(composer(), 'my draft');
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(composer().textContent).toBe('Continue with step 3'));
    expect(screen.getByText(/editing the message scheduled for/i)).toBeTruthy();
    await fill(composer(), 'Continue with step 4');
    await userEvent.click(screen.getByRole('button', { name: /save scheduled message/i }));
    await waitFor(() =>
      expect(calls.at(-1)).toBe('update {"id":"x1","text":"Continue with step 4","images":[]}'),
    );
    await waitFor(() => expect(composer().textContent).toBe('my draft'));
    expect(server.calls('chat.send')).toHaveLength(0);

    // The list follows the service.
    items = [];
    server.push('scheduled.changed', { items });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Scheduled messages' })).toBeNull(),
    );
  });
});

describe('clock badges', () => {
  it('chat rows and tabs of chats with scheduled sends show a clock', async () => {
    const { server, app, context } = await setup((s) => {
      s.handlers['sessions.list'] = () => ({ items: [summary('a'), summary('b')] });
      s.handlers['scheduled.list'] = () => ({ items: [send({ sessionId: 'a' })] });
    });
    render(ChatList, { context });
    render(TabsBar, { context });
    app.tabs.openTab('a');
    const badges = await screen.findAllByRole('img', { name: /1 scheduled message, next/i });
    expect(badges).toHaveLength(2); // the row and the tab
    server.push('scheduled.changed', {
      items: [send({ sessionId: 'a', state: 'failed', error: 'x' })],
    });
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: /could not be sent/i })).toHaveLength(2),
    );
    server.push('scheduled.changed', { items: [] });
    await waitFor(() =>
      expect(screen.queryAllByRole('img', { name: /scheduled/i })).toHaveLength(0),
    );
  });
});

describe('usage dialog per account', () => {
  const win = (key: string, utilization: number): UsageWindow => ({
    key,
    utilization,
    resetsAt: Date.now() + HOUR,
    observedAt: Date.now() - 60_000,
    source: 'usage',
  });
  const machine = (
    machineId: string,
    name: string,
    account: UsageAccount | undefined,
    windows: UsageWindow[],
    extra: Partial<UsageState> = {},
  ): UsageMachine => ({
    machineId,
    name,
    connected: true,
    state: { windows, refused: [], ...(account ? { account } : {}), ...extra },
  });
  const renderDialog = (machines: UsageMachine[]) => {
    const refresh = vi.fn(async () => {});
    const context = new Map<unknown, unknown>([
      [
        APP_CONTEXT,
        {
          usageAccounts: {
            entries: groupUsage(machines),
            dialogOpen: true,
            refreshing: false,
            refresh,
          },
        },
      ],
    ]);
    render(UsageDialog, { context });
    return { refresh };
  };
  const text = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const labels = (el: HTMLElement): (string | null)[] =>
    within(el)
      .getAllByRole('meter')
      .map((m) => m.getAttribute('aria-label'));

  it('two accounts: two sections headed by email · plan with their machines, each with its own windows', async () => {
    const me: UsageAccount = { email: 'me@x.cz', plan: 'max', kind: 'login' };
    renderDialog([
      machine('pc', 'This PC', me, [win('five_hour', 42)]),
      machine('m1', 'Ubuntu PC', me, [win('five_hour', 40)]),
      machine('m2', 'Laptop', { email: 'work@y.cz', plan: 'pro', kind: 'login' }, [
        win('seven_day', 9),
      ]),
    ]);
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    const mine = within(dialog).getByRole('region', { name: 'me@x.cz' });
    expect(text(within(mine).getByRole('heading'))).toBe('me@x.cz · Max plan');
    expect(mine.textContent).toContain('This PC, Ubuntu PC');
    expect(labels(mine)).toEqual(['5-hour limit used']);
    const work = within(dialog).getByRole('region', { name: 'work@y.cz' });
    expect(text(within(work).getByRole('heading'))).toBe('work@y.cz · Pro plan');
    expect(work.textContent).toContain('Laptop');
    expect(labels(work)).toEqual(['Weekly limit used']);
  });

  it("an unknown account's section is headed by the machine name", async () => {
    renderDialog([machine('m1', 'Ubuntu PC', undefined, [win('five_hour', 5)])]);
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    expect(text(within(dialog).getByRole('heading', { level: 3 }))).toBe('Ubuntu PC');
  });

  it('an API-key machine shows "‹machine› · API key" and the limits-don\'t-apply line', async () => {
    renderDialog([
      machine('m1', 'Ubuntu PC', { kind: 'apiKey' }, [], { rateLimitsAvailable: false }),
    ]);
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    expect(text(within(dialog).getByRole('heading', { level: 3 }))).toBe('Ubuntu PC · API key');
    expect(dialog.textContent).toMatch(/do not apply/);
  });

  it('an account without windows shows "No reading yet"', async () => {
    renderDialog([machine('pc', 'This PC', { email: 'me@x.cz', kind: 'login' }, [])]);
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    expect(dialog.textContent).toContain('No reading yet');
  });

  it('an off account says when it was last seen', async () => {
    const m = machine('m1', 'Ubuntu PC', { email: 'me@x.cz', kind: 'login' }, [
      win('five_hour', 5),
    ]);
    renderDialog([{ ...m, connected: false }]);
    const dialog = await screen.findByRole('dialog', { name: 'Usage' });
    expect(dialog.textContent).toMatch(/as of \d\d:\d\d/);
  });

  it('Refresh asks every connected machine', async () => {
    const { refresh } = renderDialog([machine('pc', 'This PC', undefined, [win('five_hour', 5)])]);
    await userEvent.click(await screen.findByRole('button', { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
