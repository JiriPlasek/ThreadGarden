import {
  POWER_CAPABILITY,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import PlugDetails from '../../src/lib/components/phone/PlugDetails.svelte';
import type { AppState } from '../../src/lib/state/context';
import { M1, project, setupTwoMachines } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

vi.setConfig({ testTimeout: 15_000 });

const HINT = "Enter this machine's plug details to turn it on from here";

const status = (): MachinePowerStatus => ({
  configured: true,
  busy: false,
  idleSince: null,
  shutsDownAt: null,
  keepAwake: { mode: 'off', until: null },
  phase: 'running',
  unpushed: [],
  problem: null,
});

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
});

/**
 * The phone paired with Ubuntu PC (M1): `capabilities` what its hello says
 * (the main PC, a desktop, has no `power`); `config` the plug details the
 * phone's core keeps; `off` its link refused (the PC is off).
 */
const start = async (
  o: {
    capabilities?: string[];
    config?: PowerConfig | null;
    off?: boolean;
    configure?: (p: unknown) => unknown;
  } = {},
) => {
  let config = o.config ?? null;
  const env = await setupTwoMachines({
    m1Capabilities: o.capabilities ?? ['remote'],
    waitForOn: !o.off,
    configure: (s: FakeServer) => {
      Object.assign(s.handlers, {
        'power.list': () => (config ? [{ machineId: M1, config }] : []),
        'power.reading': () => ({ on: !o.off, watts: o.off ? 0 : 60, at: Date.now() }),
        'power.turnOn': () => ({ cycled: false, waitMs: 0 }),
        'power.noteMeasurement': () => ({}),
        'power.configure': (p: unknown) => {
          if (o.configure) return o.configure(p);
          const q = p as { config: PowerConfig | null };
          config = q.config;
          return config;
        },
      });
    },
    configureRemote: (s: FakeServer) => {
      s.handlers['projects.list'] = () => [project('p2', 'infra')];
      s.handlers['power.status'] = () => status();
      s.handlers['power.shutdown'] = () => status();
      s.handlers['power.keepAwake'] = () => status();
      if (o.off) s.refuse = true;
    },
  });
  apps.push(env.app);
  return env;
};

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'Desk plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

/** The ⏻ menu of Ubuntu PC in the places column, open. */
const powerMenu = async (env: Awaited<ReturnType<typeof start>>) => {
  render(PlacesColumn, { context: env.context });
  const group = await waitFor(() => screen.getByRole('group', { name: 'Ubuntu PC' }));
  (await within(group).findByRole('button', { name: 'Power for Ubuntu PC' })).focus();
  await userEvent.keyboard('{Enter}');
  // bits-ui keeps an open menu out of the accessibility tree in jsdom (its anchor has no size).
  return waitFor(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error('no menu');
    return menu;
  });
};

const items = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim() ?? '');

const item = (menu: HTMLElement, name: string): HTMLElement =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === name,
  )!;

describe('plug details on the phone', () => {
  it("plug details save, and the password isn't shown again", async () => {
    const env = await start();
    render(PlugDetails, { context: env.context });
    env.app.interaction.plugFor = M1;
    const dialog = await screen.findByRole('dialog', { name: 'Plug for Ubuntu PC' });
    await userEvent.type(within(dialog).getByLabelText('Bridge address'), '192.168.1.9');
    await userEvent.type(within(dialog).getByLabelText('Plug name'), 'Desk plug');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'secret-pw');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.server.calls('power.configure')).toHaveLength(1));
    expect(env.server.calls('power.configure')[0]!.params).toEqual({
      machineId: M1,
      config: { ...CONFIG },
      password: 'secret-pw',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.app.power.config(M1)?.device).toBe('Desk plug');

    // Opened again: the details are there, the password is not.
    env.app.interaction.plugFor = M1;
    const again = await screen.findByRole('dialog', { name: 'Plug for Ubuntu PC' });
    expect((within(again).getByLabelText('Bridge address') as HTMLInputElement).value).toBe(
      '192.168.1.9',
    );
    const pw = within(again).getByLabelText('Password') as HTMLInputElement;
    expect(pw.value).toBe('');
    expect(pw.type).toBe('password');
    expect(pw.placeholder).toMatch(/stored/i);
    expect(again.textContent).not.toContain('secret-pw');
    // Saved without a new password: none is sent.
    await userEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.server.calls('power.configure')).toHaveLength(2));
    expect(env.server.calls('power.configure')[1]!.params).not.toHaveProperty('password');
  });

  it('a wrong password is reported on save', async () => {
    let calls = 0;
    const env = await start({
      configure: () => {
        calls++;
        if (calls === 1) throw new RpcFail('POWER_AUTH', 'The switch refused the password.');
        throw new RpcFail('POWER_DEVICE', 'The bridge has no plug named "Desk plug".');
      },
    });
    render(PlugDetails, { context: env.context });
    env.app.interaction.plugFor = M1;
    const dialog = await screen.findByRole('dialog', { name: 'Plug for Ubuntu PC' });
    await userEvent.type(within(dialog).getByLabelText('Bridge address'), '192.168.1.9');
    await userEvent.type(within(dialog).getByLabelText('Plug name'), 'Desk plug');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/refused the password/);
    // Still open, nothing kept.
    expect(screen.getByRole('dialog', { name: 'Plug for Ubuntu PC' })).toBeTruthy();
    expect(env.app.power.config(M1)).toBeNull();
    // A refused name says so as the core does.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toMatch(/no plug named "Desk plug"/),
    );
  });

  it('a machine without plug details shows the hint', async () => {
    const env = await start({ capabilities: ['remote', POWER_CAPABILITY] });
    const menu = await powerMenu(env);
    expect(menu.textContent).toContain(HINT);
    expect(items(menu)).not.toContain('Turn on');
    await userEvent.click(item(menu, 'Plug details…'));
    expect(env.app.interaction.plugFor).toBe(M1);
  });

  it('the main PC without details has no Turn on', async () => {
    // The main PC: a desktop, whose hello has no power capability, and off.
    const env = await start({ off: true });
    let menu = await powerMenu(env);
    expect(items(menu)).not.toContain('Turn on');
    expect(menu.textContent).toContain(HINT);
    await userEvent.keyboard('{Escape}');

    // With its plug details, the phone can turn it on.
    const withDetails = await start({ off: true, config: CONFIG });
    document.body.innerHTML = '';
    menu = await powerMenu(withDetails);
    await waitFor(() => expect(items(menu)).toContain('Turn on'));
    await userEvent.click(item(menu, 'Turn on'));
    await waitFor(() => expect(withDetails.server.calls('power.turnOn')).toHaveLength(1));
  });

  it('a phone never offers a hard cut', async () => {
    // On, with details and power control: shut down is the machine's own, never the plug's.
    const env = await start({ capabilities: ['remote', POWER_CAPABILITY], config: CONFIG });
    const menu = await powerMenu(env);
    await waitFor(() => expect(items(menu)).toContain('Shut down now'));
    for (const item of items(menu)) expect(item).not.toMatch(/cut|force|switch off|power off/i);
    // The main PC (no power capability), on: nothing to shut it down with from here.
    const main = await start({ config: CONFIG });
    document.body.innerHTML = '';
    const mainMenu = await powerMenu(main);
    expect(items(mainMenu)).not.toContain('Shut down now');
    for (const item of items(mainMenu)) expect(item).not.toMatch(/cut|force|switch off|power off/i);
  });

  it('never hands the plug to the machine (power.adopt)', async () => {
    const env = await start({ capabilities: ['remote', POWER_CAPABILITY] });
    render(PlugDetails, { context: env.context });
    env.app.interaction.plugFor = M1;
    const dialog = await screen.findByRole('dialog', { name: 'Plug for Ubuntu PC' });
    await userEvent.type(within(dialog).getByLabelText('Bridge address'), '192.168.1.9');
    await userEvent.type(within(dialog).getByLabelText('Plug name'), 'Desk plug');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'pw');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.server.calls('power.configure')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(env.remote.calls('power.adopt')).toHaveLength(0);
  });
});
