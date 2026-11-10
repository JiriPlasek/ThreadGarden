import type { UsageAccount, UsageState, UsageWindow } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import type { MachineScope } from '../../src/lib/state/scope';
import { UsageAccounts } from '../../src/lib/state/usage-accounts.svelte';
import { UsageStore } from '../../src/lib/state/usage.svelte';
import { chipWindows, groupUsage, type UsageMachine } from '../../src/lib/usage/accounts';

const win = (key: string, observedAt: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  key,
  utilization: 10,
  observedAt,
  source: 'usage',
  ...over,
});

const login = (email: string, plan = 'max'): UsageAccount => ({ email, plan, kind: 'login' });

const machine = (
  machineId: string,
  account: UsageAccount | undefined,
  windows: UsageWindow[] = [],
  connected = true,
): UsageMachine => {
  const state: UsageState = { windows, refused: [], ...(account ? { account } : {}) };
  return { machineId, name: machineId === 'pc' ? 'This PC' : machineId, state, connected };
};

describe('groupUsage', () => {
  it('keeps Claude and ChatGPT quotas separate even with the same email on two machines', () => {
    const machines = ['pc', 'laptop'].map((id) => {
      const m = machine(id, login('same@example.test'), [
        win('five_hour', 100, { utilization: 90 }),
      ]);
      m.state.providers = {
        codex: {
          windows: [win('five_hour', 200, { utilization: 20 })],
          refused: [],
          account: { ...login('same@example.test', 'pro'), runtime: 'codex' },
        },
      };
      return m;
    });
    const entries = groupUsage(machines);
    expect(entries.map((e) => e.key)).toEqual([
      'email:same@example.test',
      'codex:email:same@example.test',
    ]);
    expect(entries.map((e) => e.windows[0]?.utilization)).toEqual([90, 20]);
    expect(entries.map((e) => e.machines.length)).toEqual([2, 2]);
  });
  it('one account everywhere is one entry with both machines and the newest window per key', () => {
    const entries = groupUsage([
      machine('pc', login('me@x.cz'), [
        win('five_hour', 200, { utilization: 42 }),
        win('seven_day', 100),
      ]),
      machine('m1', login('me@x.cz'), [
        win('five_hour', 100, { utilization: 30 }),
        win('seven_day', 300, { utilization: 18 }),
      ]),
    ]);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e!.key).toBe('email:me@x.cz');
    expect(e!.account?.email).toBe('me@x.cz');
    expect(e!.machines.map((m) => m.machineId)).toEqual(['pc', 'm1']);
    expect(e!.windows.find((w) => w.key === 'five_hour')).toMatchObject({
      observedAt: 200,
      utilization: 42,
    });
    expect(e!.windows.find((w) => w.key === 'seven_day')).toMatchObject({
      observedAt: 300,
      utilization: 18,
    });
    expect(e!.windows).toHaveLength(2);
    expect(e!.asOf).toBeUndefined();
  });

  it('two emails are two entries', () => {
    const entries = groupUsage([
      machine('pc', login('me@x.cz'), [win('five_hour', 1)]),
      machine('m1', login('work@y.cz'), [win('five_hour', 2)]),
    ]);
    expect(entries.map((e) => e.key)).toEqual(['email:me@x.cz', 'email:work@y.cz']);
    expect(entries.map((e) => e.machines.map((m) => m.machineId))).toEqual([['pc'], ['m1']]);
  });

  it("email case and spaces don't split an account", () => {
    const entries = groupUsage([
      machine('pc', login('Me@X.cz')),
      machine('m1', login('  me@x.CZ ')),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe('email:me@x.cz');
    expect(entries[0]!.machines.map((m) => m.machineId)).toEqual(['pc', 'm1']);
  });

  it('a machine without an account is its own entry, even next to a known one', () => {
    const entries = groupUsage([
      machine('pc', login('me@x.cz'), [win('five_hour', 1)]),
      machine('m1', undefined, [win('five_hour', 2)]),
      machine('m2', login('me@x.cz'), [win('five_hour', 3)]),
    ]);
    expect(entries.map((e) => e.key)).toEqual(['email:me@x.cz', 'machine:m1']);
    expect(entries[0]!.machines.map((m) => m.machineId)).toEqual(['pc', 'm2']);
    expect(entries[1]!.account).toBeUndefined();
    expect(entries[1]!.windows.map((w) => w.observedAt)).toEqual([2]);
  });

  it('an API-key machine is its own entry', () => {
    const entries = groupUsage([
      machine('pc', { kind: 'apiKey' }),
      machine('m1', { kind: 'apiKey' }),
      machine('m2', { kind: 'provider', provider: 'bedrock' }),
    ]);
    expect(entries.map((e) => e.key)).toEqual(['machine:pc', 'machine:m1', 'machine:m2']);
    expect(entries[2]!.account).toEqual({ kind: 'provider', provider: 'bedrock' });
  });

  it("asOf is set only when all of an entry's machines are disconnected", () => {
    const [both] = groupUsage([
      machine('pc', login('me@x.cz'), [win('five_hour', 100)], false),
      machine('m1', login('me@x.cz'), [win('seven_day', 400)], false),
    ]);
    expect(both!.asOf).toBe(400);

    const [one] = groupUsage([
      machine('pc', login('me@x.cz'), [win('five_hour', 100)], true),
      machine('m1', login('me@x.cz'), [win('seven_day', 400)], false),
    ]);
    expect(one!.asOf).toBeUndefined();
  });
});

describe('chipWindows', () => {
  it('chipWindows orders 5h, Week, then model windows', () => {
    const [e] = groupUsage([
      machine('pc', login('me@x.cz'), [
        win('seven_day_sonnet', 1),
        win('extra_usage', 1),
        win('model:fable', 1, { label: 'Fable' }),
        win('seven_day', 1),
        win('overage', 1),
        win('seven_day_opus', 1),
        win('five_hour', 1),
        win('seven_day_oauth_apps', 1),
      ]),
    ]);
    expect(chipWindows(e!).map((w) => w.key)).toEqual([
      'five_hour',
      'seven_day',
      'model:fable',
      'seven_day_opus',
      'seven_day_sonnet',
    ]);
  });

  it('an event window of unknown type stands in for the 5-hour one', () => {
    const [e] = groupUsage([
      machine('pc', login('me@x.cz'), [win('seven_day', 1), win('current', 1)]),
    ]);
    expect(chipWindows(e!).map((w) => w.key)).toEqual(['current', 'seven_day']);
  });
});

describe('UsageAccounts', () => {
  const accountsOf = (stores: Record<string, UsageStore>): UsageAccounts =>
    new UsageAccounts(
      {
        all: () =>
          Object.entries(stores).map(([machineId, usage]) => ({
            machineId,
            usage,
          })) as MachineScope[],
      },
      (id) => id,
    );

  it('an off machine whose kept copy is an empty state is not listed', () => {
    const empty: UsageState = { windows: [], refused: [] };
    localStorage.setItem('threadgarden.usage.m1', JSON.stringify(empty));
    const off = new UsageStore({ remember: 'm1' });
    expect(off.value).toEqual(empty);
    expect(accountsOf({ pc: new UsageStore(), m1: off }).entries).toEqual([]);
  });

  it('an off machine with a known account is listed', () => {
    const kept: UsageState = { windows: [], refused: [], account: login('me@x.cz') };
    localStorage.setItem('threadgarden.usage.m1', JSON.stringify(kept));
    const entries = accountsOf({ m1: new UsageStore({ remember: 'm1' }) }).entries;
    expect(entries.map((e) => e.key)).toEqual(['email:me@x.cz']);
  });
});
