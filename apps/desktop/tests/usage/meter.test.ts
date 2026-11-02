import type { UsageAccount, UsageWindow } from '@threadgarden/protocol';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import UsageMeter from '../../src/lib/components/layout/UsageMeter.svelte';
import { clockTime } from '../../src/lib/format/usage';
import { APP_CONTEXT } from '../../src/lib/state/context';
import { groupUsage, type UsageMachine } from '../../src/lib/usage/accounts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0);

const win = (key: string, utilization: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  key,
  utilization,
  resetsAt: NOW + 2 * HOUR,
  observedAt: NOW - 60_000,
  source: 'usage',
  ...over,
});

const login = (email: string): UsageAccount => ({ email, kind: 'login' });

const machine = (
  machineId: string,
  account: UsageAccount | undefined,
  windows: UsageWindow[],
  connected = true,
): UsageMachine => ({
  machineId,
  name: machineId === 'pc' ? 'This PC' : machineId,
  state: { windows, refused: [], ...(account ? { account } : {}) },
  connected,
});

const renderMeter = (machines: UsageMachine[], several = false, compact?: boolean) => {
  const open = vi.fn();
  const context = new Map<unknown, unknown>([
    [
      APP_CONTEXT,
      {
        usage: { now: NOW },
        usageAccounts: { entries: groupUsage(machines), open },
        machines: { several },
      },
    ],
  ]);
  render(UsageMeter, { context, props: compact === undefined ? {} : { compact } });
  return { open };
};

const text = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const mine = [
  win('five_hour', 42, { status: 'allowed' }),
  win('seven_day', 18),
  win('model:fable', 30, { label: 'Fable' }),
  win('seven_day_oauth_apps', 99),
];

describe('usage chips', () => {
  it('one account: one chip, no machine names when only This PC exists', () => {
    renderMeter([machine('pc', login('me@x.cz'), mine)]);
    const chips = screen.getAllByRole('button', { name: /^usage/i });
    expect(chips).toHaveLength(1);
    expect(text(chips[0]!)).toBe('5h 42% · Week 18% · Fable 30%');
  });

  it('two accounts: two chips with their machine names; either opens the dialog', async () => {
    const { open } = renderMeter(
      [
        machine('pc', login('me@x.cz'), mine),
        machine('m1', login('me@x.cz'), mine),
        machine('m2', login('work@y.cz'), [win('five_hour', 7)]),
      ],
      true,
    );
    const chips = screen.getAllByRole('button', { name: /^usage/i });
    expect(chips.map(text)).toEqual(['This PC, m1 · 5h 42% · Week 18% · Fable 30%', 'm2 · 5h 7%']);
    await userEvent.click(chips[1]!);
    await userEvent.click(chips[0]!);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('the hover lists the email, then one line per window with its reset', () => {
    renderMeter([machine('pc', login('me@x.cz'), mine)]);
    const lines = screen.getByRole('button', { name: /^usage/i }).title.split('\n');
    expect(lines[0]).toBe('me@x.cz');
    expect(lines[1]).toBe('5-hour limit: 42%, resets in 2 h, at ' + clockTime(NOW + 2 * HOUR));
    expect(lines).toHaveLength(1 + mine.length);
    expect(lines[3]).toMatch(/^Weekly limit · Fable: 30%, resets /);
  });

  it('says when the account is not known yet', () => {
    renderMeter([machine('pc', undefined, mine)]);
    expect(screen.getByRole('button', { name: /^usage/i }).title.split('\n')[0]).toBe(
      'Account not known yet',
    );
  });

  it("an off machine's chip says as of HH:MM", () => {
    renderMeter([machine('m1', login('me@x.cz'), mine, false)], true);
    const chip = screen.getByRole('button', { name: /^usage/i });
    expect(text(chip)).toContain('as of ' + clockTime(NOW - 60_000));
  });

  it('a stale rejected window past its reset is not red', () => {
    renderMeter([
      machine('pc', login('me@x.cz'), [
        win('five_hour', 100, { status: 'rejected', resetsAt: NOW - 1000 }),
      ]),
    ]);
    const chip = screen.getByRole('button', { name: /^usage/i });
    expect(chip.querySelector('.text-red-700')).toBeNull();
    expect(text(chip)).not.toContain('Limit reached');
    expect(text(chip)).not.toContain('100%');
  });

  it('a rejected window is red', () => {
    renderMeter([machine('pc', login('me@x.cz'), [win('five_hour', 100, { status: 'rejected' })])]);
    const chip = screen.getByRole('button', { name: /^usage/i });
    expect(chip.querySelector('.text-red-700')).not.toBeNull();
    expect(text(chip)).toContain('Limit reached');
  });

  it('compact shows only the 5h figure', () => {
    renderMeter([machine('pc', login('me@x.cz'), mine)], false, true);
    expect(text(screen.getByRole('button', { name: /^usage/i }))).toBe('5h 42%');
  });

  it('no chip for an API-key entry or an entry without a 5-hour window', () => {
    renderMeter([
      machine('pc', { kind: 'apiKey' }, [win('five_hour', 5)]),
      machine('m1', login('a@x.cz'), [win('seven_day', 5)]),
    ]);
    expect(screen.queryAllByRole('button', { name: /^usage/i })).toHaveLength(0);
  });
});
