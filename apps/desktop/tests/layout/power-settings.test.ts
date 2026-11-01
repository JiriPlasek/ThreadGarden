import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type PowerConfig,
  type ProbeResult,
} from '@threadgarden/protocol';
import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import {
  isZigbeeName,
  plugNameFor,
  powerFailure,
  suggestedName,
  suggestOffWatts,
} from '../../src/lib/power-setup';
import { RequestError } from '../../src/lib/service/client';
import type { AppState } from '../../src/lib/state/context';
import { RpcFail, type FakeServer } from '../service/fake-ws';
import { M1, setupTwoMachines } from './harness';

vi.setConfig({ testTimeout: 20_000 });

const ZIGBEE: ProbeResult = {
  version: '14.2.0',
  kind: 'tasmota-zigbee',
  devices: [
    { id: '0xAB12', name: 'PC_plug', on: true, watts: 47, metering: true },
    { id: '0xCD34', name: 'Lamp', on: true, watts: null, metering: false },
  ],
  plug: null,
};
const WIFI: ProbeResult = {
  version: '14.2.0',
  kind: 'tasmota-plug',
  devices: [],
  plug: { on: true, watts: 52, at: 1 },
};

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC_plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
  cleanup();
});

type Calls = { log: string[]; configure: unknown[]; adopt: unknown[]; settingsSet: unknown[] };

const start = async (
  o: {
    stored?: PowerConfig;
    probe?: () => ProbeResult;
    configure?: (p: { config: PowerConfig | null }) => unknown;
    capabilities?: string[];
    idle?: number | null;
    local?: (s: FakeServer) => void;
    remote?: (s: FakeServer) => void;
    /** The machine never answers (it is off). */
    down?: boolean;
  } = {},
) => {
  const calls: Calls = { log: [], configure: [], adopt: [], settingsSet: [] };
  const env = await setupTwoMachines({
    m1Capabilities: o.capabilities ?? ['remote', POWER_CAPABILITY],
    waitForOn: !o.down,
    configure: (s) => {
      s.handlers['power.list'] = () => (o.stored ? [{ machineId: M1, config: o.stored }] : []);
      s.handlers['power.reading'] = () => ({ on: true, watts: 47, at: Date.now() });
      s.handlers['power.unlock'] = () => ({});
      s.handlers['power.noteMeasurement'] = () => ({});
      s.handlers['power.probe'] = () => {
        calls.log.push('probe');
        return (o.probe ?? (() => ZIGBEE))();
      };
      s.handlers['power.configure'] = (p) => {
        calls.log.push('configure');
        calls.configure.push(p);
        const r = (o.configure ?? ((q: { config: PowerConfig | null }) => q.config))(
          p as { config: PowerConfig | null },
        );
        return r;
      };
      o.local?.(s);
    },
    configureRemote: (s) => {
      s.handlers['power.status'] = () => ({
        configured: true,
        busy: false,
        idleSince: null,
        shutsDownAt: null,
        keepAwake: { mode: 'off', until: null },
        phase: 'running',
        unpushed: [],
        problem: null,
      });
      s.handlers['power.adopt'] = (p) => {
        calls.log.push('adopt');
        calls.adopt.push(p);
        return {};
      };
      s.handlers['settings.get'] = () => ({
        idleShutdownMinutes: o.idle === undefined ? 60 : o.idle,
      });
      s.handlers['settings.set'] = (p) => {
        calls.settingsSet.push(p);
        return { idleShutdownMinutes: (p as { idleShutdownMinutes: number }).idleShutdownMinutes };
      };
      o.remote?.(s);
      if (o.down) s.refuse = true;
    },
  });
  apps.push(env.app);
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  const settings = await screen.findByRole('dialog', { name: /^settings$/i });
  const card = within(settings).getByRole('group', { name: 'Ubuntu PC' });
  return { ...env, calls, card };
};

const openSetup = async (card: HTMLElement) => {
  await userEvent.click(await within(card).findByRole('button', { name: /set up power control/i }));
  return screen.findByRole('dialog', { name: /set up power control/i });
};

const connect = async (dialog: HTMLElement, password = 'secret') => {
  await userEvent.type(within(dialog).getByLabelText('Address'), '192.168.1.9');
  await userEvent.type(within(dialog).getByLabelText('Password'), password);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
};

describe('power setup', () => {
  it('connect → choose → save sends probe, configure, adopt in order and stores the password', async () => {
    const { card, calls, passwords } = await start();
    const dialog = await openSetup(card);
    expect(within(dialog).getByText('User name is always admin')).toBeTruthy();
    await connect(dialog);

    // Only plugs that measure power are offered.
    const radio = await within(dialog).findByRole('radio', { name: 'PC_plug — 47 W' });
    expect(within(dialog).queryByRole('radio', { name: /Lamp/ })).toBeNull();
    await userEvent.click(radio);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(await within(dialog).findByText(/47 W/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Off below (W)')).toHaveProperty('value', '5');
    expect(within(dialog).getByLabelText('Wait before switching on (s)')).toHaveProperty(
      'value',
      '90',
    );
    expect(
      within(dialog).queryByRole('button', { name: /switch.*off|turn off|off now/i }),
    ).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.log).toEqual(['probe', 'configure', 'adopt']));
    expect(calls.configure[0]).toMatchObject({
      machineId: M1,
      password: 'secret',
      config: { kind: 'tasmota-zigbee', address: '192.168.1.9', device: 'PC_plug', offWatts: 5 },
    });
    expect(calls.adopt[0]).toMatchObject({ config: { device: 'PC_plug' }, password: 'secret' });
    expect(await passwords.get(M1)).toBe('secret');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /set up power/i })).toBeNull());
    expect(within(card).getByText('192.168.1.9')).toBeTruthy();
  });

  it('keeps Connect disabled until there is an address and a password', async () => {
    const { card } = await start();
    const dialog = await openSetup(card);
    const button = within(dialog).getByRole('button', { name: 'Connect' });
    expect(button).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByLabelText('Address'), '192.168.1.9');
    expect(button).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByLabelText('Password'), 'x');
    expect(button).toHaveProperty('disabled', false);
  });

  it('wrong password shows the auth sentence', async () => {
    const { card } = await start({
      local: (s) => {
        s.handlers['power.probe'] = () => {
          throw new RpcFail(POWER_ERRORS.auth, 'nope');
        };
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog, 'wrong');
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      "The switch didn't accept that password.",
    );
    // Still on step 1.
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('POWER_CONFLICT lists the problems', async () => {
    const { card, passwords } = await start({
      configure: () => {
        throw new RpcFail(
          POWER_ERRORS.conflict,
          'Rule1 is already in use. Timer16 is already in use.',
        );
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('radio', { name: /PC_plug/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Save' }));
    const alert = await within(dialog).findByRole('alert');
    const items = within(alert).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Rule1 is already in use.',
      'Timer16 is already in use.',
    ]);
    // Nothing was saved, so no password is kept either.
    expect(await passwords.get(M1)).toBeNull();
  });

  it('a Wi-Fi plug skips the choice and says it is experimental', async () => {
    const { card } = await start({ probe: () => WIFI });
    const dialog = await openSetup(card);
    await connect(dialog);
    expect(await within(dialog).findByText('Experimental')).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).getByLabelText('Off below (W)')).toBeTruthy();
    expect(within(dialog).getByText(/52 W/)).toBeTruthy();
  });

  it('pairs a new plug and names it after the machine', async () => {
    const paired = { id: '0xEF56', name: null, on: true, watts: 3, metering: true };
    const renamed: unknown[] = [];
    const { card } = await start({
      local: (s) => {
        s.handlers['power.pairPlug'] = () => paired;
        s.handlers['power.rename'] = (p) => {
          renamed.push(p);
          return {};
        };
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: /pair a new plug/i }));
    const radio = await within(dialog).findByRole('radio', { name: 'Ubuntu_PC_plug — 3 W' });
    expect(renamed[0]).toMatchObject({ id: '0xEF56', name: 'Ubuntu_PC_plug', password: 'secret' });
    expect((radio as HTMLInputElement).checked).toBe(true);
  });

  it('says so when no new plug joined', async () => {
    const { card } = await start({
      local: (s) => {
        s.handlers['power.pairPlug'] = () => null;
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: /pair a new plug/i }));
    expect(
      await within(dialog).findByText(
        'No new plug joined. Try again, and hold its button until the LED blinks fast.',
      ),
    ).toBeTruthy();
  });

  it('suggestion appears and Use sets offWatts 12', async () => {
    const { card, calls } = await start({
      stored: { ...CONFIG, measured: { running: 47, standby: 0 } },
    });
    const text = await within(card).findByText(
      'Measured: 47 W running, 0 W shut down — suggest off below 12 W',
    );
    expect(text).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(calls.configure.length).toBe(1));
    expect(calls.configure[0]).toMatchObject({
      machineId: M1,
      config: { ...CONFIG, offWatts: 12, measured: { running: 47, standby: 0 } },
    });
  });

  it('shows no suggestion when it matches the line', async () => {
    const { card } = await start({
      stored: { ...CONFIG, offWatts: 12, measured: { running: 47, standby: 0 } },
    });
    expect(await within(card).findByText('192.168.1.9')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Use' })).toBeNull();
  });

  it('idle select writes idleShutdownMinutes 120 to the machine', async () => {
    const { card, calls } = await start({ stored: CONFIG });
    const select = (await within(card).findByLabelText(
      'Shut down after idle',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('60'));
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Never',
      '30 min',
      '1 hour',
      '2 hours',
      '4 hours',
    ]);
    await userEvent.selectOptions(select, '2 hours');
    await waitFor(() => expect(calls.settingsSet).toEqual([{ idleShutdownMinutes: 120 }]));
  });

  it('remove clears config, adopt null, keychain', async () => {
    const { card, calls, passwords } = await start({
      stored: CONFIG,
      configure: () => null,
    });
    await passwords.set(M1, 'secret');
    await userEvent.click(
      await within(card).findByRole('button', { name: 'Remove power control' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.adopt.at(-1)).toEqual({ config: null }));
    expect(calls.configure).toEqual([{ machineId: M1, config: null }]);
    expect(await passwords.get(M1)).toBeNull();
    expect(await within(card).findByRole('button', { name: /set up power control/i })).toBeTruthy();
  });

  it('is absent without the power capability', async () => {
    const { card } = await start({ capabilities: ['remote'] });
    expect(within(card).queryByText('Power')).toBeNull();
    expect(within(card).queryByRole('button', { name: /set up power control/i })).toBeNull();
  });
});

describe('power setup, fixes', () => {
  const pickAndNext = async (dialog: HTMLElement) => {
    await userEvent.click(await within(dialog).findByRole('radio', { name: /PC_plug/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
  };

  it('shows a plug whose name Threadgarden cannot use as disabled, with the way out', async () => {
    const { card } = await start({
      probe: () => ({
        ...ZIGBEE,
        devices: [
          ...ZIGBEE.devices,
          { id: '0xGH78', name: 'Desk lamp plug', on: true, watts: 9, metering: true },
        ],
      }),
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    const radio = await within(dialog).findByRole('radio', { name: /Desk lamp plug/ });
    expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(
      within(dialog).getByText(
        "Its name has characters Threadgarden can't use. Rename it on the switch's console with ZbName 0xGH78,Desk_lamp_plug, then Refresh.",
      ),
    ).toBeTruthy();
    expect(
      (within(dialog).getByRole('radio', { name: /PC_plug/ }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('shows the switch its own message when pairing could not be closed', async () => {
    const { card } = await start({
      local: (s) => {
        s.handlers['power.pairPlug'] = () => {
          throw new RpcFail(
            POWER_ERRORS.unreachable,
            "Couldn't close pairing on the switch; run ZbPermitJoin 0.",
          );
        };
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: /pair a new plug/i }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      "Couldn't close pairing on the switch; run ZbPermitJoin 0.",
    );
  });

  it('says a newly paired plug that cannot measure is a plug', async () => {
    const { card } = await start({
      local: (s) => {
        s.handlers['power.pairPlug'] = () => ({
          id: '0xEF56',
          name: null,
          on: true,
          watts: null,
          metering: false,
        });
        s.handlers['power.rename'] = () => ({});
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: /pair a new plug/i }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "This plug can't measure power, so Threadgarden can't tell when the machine is off.",
    );
  });

  it('announces the pairing countdown once, not every second', async () => {
    let finish: (v: null) => void = () => {};
    const { card } = await start({
      local: (s) => {
        s.handlers['power.pairPlug'] = () => new Promise((r) => (finish = r));
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: /pair a new plug/i }));
    const count = await within(dialog).findByText(/Waiting for a new plug… \d+ s/);
    expect(count.closest('[aria-live]')).toBeNull();
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(within(dialog).getByRole('status').textContent).toMatch(/up to a minute/);
    finish(null);
  });

  it('clears the choice visibly when Refresh no longer lists the plug', async () => {
    let n = 0;
    const { card } = await start({
      probe: () => (n++ === 0 ? ZIGBEE : { ...ZIGBEE, devices: [] }),
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await pickAndNext(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Refresh' }));
    expect(
      await within(dialog).findByText(
        "The plug you chose isn't listed any more. Go back and choose it again.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('hides a suggestion above 100 W', async () => {
    const { card } = await start({
      stored: { ...CONFIG, measured: { running: 500, standby: 0 } },
      local: (s) => {
        // The plug reads what was measured, so the measurement stays as stored.
        s.handlers['power.reading'] = () => ({ on: true, watts: 500, at: Date.now() });
      },
    });
    expect(await within(card).findByText('192.168.1.9')).toBeTruthy();
    expect(within(card).queryByText(/suggest off below/)).toBeNull();
  });

  it('says a failed Use in plain words', async () => {
    const { card } = await start({
      stored: { ...CONFIG, measured: { running: 47, standby: 0 } },
      configure: () => {
        throw new RpcFail(POWER_ERRORS.auth, 'raw');
      },
    });
    await userEvent.click(await within(card).findByRole('button', { name: 'Use' }));
    expect((await within(card).findByRole('alert')).textContent).toBe(
      "The switch didn't accept that password.",
    );
  });

  it('shows an idle setting that could not be read', async () => {
    const { card } = await start({
      stored: CONFIG,
      remote: (s) => {
        s.handlers['settings.get'] = () => {
          throw new RpcFail('INTERNAL', 'cannot read settings');
        };
      },
    });
    expect((await within(card).findByRole('alert')).textContent).toBe('cannot read settings');
  });

  it('still shows the Power section of a configured machine that has been off since launch', async () => {
    const { card } = await start({ stored: CONFIG, down: true });
    expect(await within(card).findByText('192.168.1.9')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Remove power control' })).toBeTruthy();
  });

  it('says the machine will be told when it is next on after a removal while off', async () => {
    const { card } = await start({ stored: CONFIG, down: true, configure: () => null });
    await userEvent.click(
      await within(card).findByRole('button', { name: 'Remove power control' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await within(card).findByText("Ubuntu PC will be told when it's next on.")).toBeTruthy();
  });

  it('shows a failed push to the machine after Save', async () => {
    const { card } = await start({
      remote: (s) => {
        s.handlers['power.adopt'] = () => {
          throw new RpcFail('INTERNAL', 'The machine could not keep it.');
        };
      },
    });
    const dialog = await openSetup(card);
    await connect(dialog);
    await pickAndNext(dialog);
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Save' }));
    expect((await within(card).findByRole('alert')).textContent).toContain(
      'The machine could not keep it.',
    );
  });
});

describe('power setup words', () => {
  const fail = (code: string, message = code) => new RequestError(code, message);

  it('maps every POWER_ERRORS code to its exact sentence', () => {
    const at = '192.168.1.9';
    const expected: Record<string, ReturnType<typeof powerFailure>> = {
      [POWER_ERRORS.unreachable]: {
        text: "Threadgarden couldn't reach the switch at 192.168.1.9. Check the address and that it's on.",
      },
      [POWER_ERRORS.auth]: { text: "The switch didn't accept that password." },
      [POWER_ERRORS.notTasmota]: { text: "That address doesn't answer like a Tasmota device." },
      [POWER_ERRORS.tooOld]: {
        text: 'This switch runs Tasmota 12.5.0; Threadgarden needs 14.0 or newer.',
      },
      [POWER_ERRORS.refused]: {
        text: "The switch refused Threadgarden's request. On its page, Consoles → Console, run SetOption128 1, then try again.",
      },
      [POWER_ERRORS.noMetering]: {
        text: "This switch can't measure power, so Threadgarden can't tell when the machine is off.",
      },
      [POWER_ERRORS.conflict]: { list: ['Rule1 is in use.', 'Timer16 is in use.'] },
      [POWER_ERRORS.notConfigured]: { text: 'Own words.' },
    };
    const messages: Record<string, string> = {
      [POWER_ERRORS.tooOld]: 'This switch runs Tasmota 12.5.0; x',
      [POWER_ERRORS.conflict]: 'Rule1 is in use. Timer16 is in use.',
      [POWER_ERRORS.notConfigured]: 'Own words.',
    };
    // Every code is covered here: a new one must be added to this table.
    expect(Object.keys(expected).sort()).toEqual(Object.values(POWER_ERRORS).sort());
    for (const code of Object.values(POWER_ERRORS)) {
      expect(powerFailure(fail(code, messages[code] ?? code), at)).toEqual(expected[code]);
    }
    expect(powerFailure(fail('SOMETHING', 'Odd.'), at)).toEqual({ text: 'Odd.' });
  });

  it('names a new plug safely', () => {
    expect(plugNameFor('Ubuntu PC')).toBe('Ubuntu_PC_plug');
    expect(plugNameFor('a  b -- c')).toMatch(/^[A-Za-z0-9_.-]{1,32}$/);
    expect(plugNameFor('x'.repeat(80))).toHaveLength(32);
    expect(plugNameFor('???')).toBe('plug');
    // Cut at 27 characters, then trimmed again: no doubled or dangling separator.
    expect(plugNameFor(`${'a'.repeat(26)} b`)).toBe(`${'a'.repeat(26)}_plug`);
    expect(suggestedName('Desk lamp plug')).toBe('Desk_lamp_plug');
    expect(isZigbeeName('Desk lamp plug')).toBe(false);
    expect(isZigbeeName('PC_plug')).toBe(true);
  });

  it('suggests a line a quarter of the way up', () => {
    expect(suggestOffWatts(47, 0)).toBe(12);
    expect(suggestOffWatts(3, 0)).toBe(2);
  });
});
