import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceBanner from '../../src/lib/components/ServiceBanner.svelte';
import ServiceDialogs from '../../src/lib/components/ServiceDialogs.svelte';
import { ServiceClient } from '../../src/lib/service/client';
import { setup, summary } from '../layout/harness';
import { FakeServer } from '../service/fake-ws';

const native = vi.hoisted(() => {
  const order: string[] = [];
  const tray = new Map<string, () => void>();
  return {
    order,
    tray,
    quitApp: vi.fn(async () => void order.push('quitApp')),
    stopService: vi.fn(async () => void order.push('stopService')),
    serviceConnection: vi.fn(async () => {
      order.push('serviceConnection');
      return { port: 2, token: 'fresh', serviceVersion: '0.1.0', appVersion: '0.1.0' };
    }),
    onTray: vi.fn(async (event: string, cb: () => void) => {
      tray.set(event, cb);
      return () => tray.delete(event);
    }),
  };
});
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  quitApp: native.quitApp,
  stopService: native.stopService,
  serviceConnection: native.serviceConnection,
  onTray: native.onTray,
}));

type ListParams = { place: { kind: string } };

/** Two pahub chats running and one terminal session. */
const withAgents = (server: FakeServer) => {
  server.handlers['sessions.list'] = (p) =>
    (p as ListParams).place.kind === 'running'
      ? {
          items: [
            summary('w1', { status: 'working', live: true, title: 'Fix the build' }),
            summary('w2', { status: 'idle', live: true, title: 'Write the docs' }),
            summary('x1', {
              status: 'working',
              title: 'Terminal session',
              external: { kind: 'interactive', pid: 1 } as never,
            }),
          ],
        }
      : { items: [] };
  server.handlers['service.shutdown'] = (p) => {
    native.order.push(`service.shutdown ${JSON.stringify(p)}`);
    return {};
  };
  server.handlers['work.stopAll'] = () => ({ stopped: 2 });
};

describe('tray actions', () => {
  afterEach(() => {
    native.order.length = 0;
    native.tray.clear();
    vi.clearAllMocks();
  });

  it('quit completely confirms then shuts service down then quits', async () => {
    const { app, context } = await setup(withAgents);
    await app.agents.refresh();
    render(ServiceDialogs, { context });
    await waitFor(() => expect(native.tray.has('quit-all')).toBe(true));

    native.tray.get('quit-all')!();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/quit pahub completely/i)).toBeTruthy();
    // The confirmation lists the running pahub agents (not terminal sessions).
    const list = within(dialog).getByRole('list', { name: /agents to stop/i });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toEqual(['Fix the build', 'Write the docs']);
    expect(native.order).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: /quit completely/i }));
    await waitFor(() =>
      expect(native.order).toEqual(['service.shutdown {"stopAll":true}', 'quitApp']),
    );
  });

  it('cancelling quit completely does nothing', async () => {
    const { app, context } = await setup(withAgents);
    await app.agents.refresh();
    render(ServiceDialogs, { context });
    await waitFor(() => expect(native.tray.has('quit-all')).toBe(true));
    native.tray.get('quit-all')!();
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(native.order).toEqual([]);
    expect(native.quitApp).not.toHaveBeenCalled();
  });

  it('tray stop all work lists the agents, then stops them', async () => {
    const { app, server, context } = await setup(withAgents);
    await app.agents.refresh();
    render(ServiceDialogs, { context });
    await waitFor(() => expect(native.tray.has('stop-all')).toBe(true));
    native.tray.get('stop-all')!();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Fix the build')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: /stop all work/i }));
    await waitFor(() => expect(server.calls('work.stopAll')).toHaveLength(1));
    expect(native.quitApp).not.toHaveBeenCalled();
  });
});

describe('service restart', () => {
  afterEach(() => {
    native.order.length = 0;
    vi.clearAllMocks();
  });

  it('incompatible service shows restart banner', async () => {
    const { app, server, context } = await setup(withAgents);
    app.connection.markIncompatible();
    render(ServiceBanner, { context, props: { blocking: true } });
    render(ServiceDialogs, { context });

    const banner = screen.getByRole('alert');
    expect(within(banner).getByText('The pahub service is an older version')).toBeTruthy();
    await userEvent.click(within(banner).getByRole('button', { name: /restart service/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/can't list/i)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: /restart service/i }));

    // No protocol in common: the shell stops the old service, then a fresh one is found.
    await waitFor(() => expect(native.order).toEqual(['stopService', 'serviceConnection']));
    await waitFor(() => expect(app.connection.status).toBe('open'));
    expect(server.calls('service.shutdown')).toHaveLength(0);
  });

  it('older service shows a non-blocking banner; restart shuts it down and reconnects', async () => {
    const { app, server, context } = await setup(withAgents);
    app.connection.setVersions({ serviceVersion: '0.0.9', appVersion: '0.1.0' });
    await app.agents.refresh();
    render(ServiceBanner, { context });
    render(ServiceDialogs, { context });

    const banner = screen.getByRole('status');
    expect(within(banner).getByText(/the pahub service is an older version/i)).toBeTruthy();
    await userEvent.click(within(banner).getByRole('button', { name: /restart service/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Write the docs')).toBeTruthy();
    const sockets = server.sockets.length;
    await userEvent.click(within(dialog).getByRole('button', { name: /restart service/i }));

    await waitFor(() =>
      expect(native.order).toEqual([
        'service.shutdown {"stopAll":true}',
        'stopService',
        'serviceConnection',
      ]),
    );
    // The client moved to the fresh service (a new socket) and the banner is gone.
    await waitFor(() => expect(server.sockets.length).toBe(sockets + 1));
    expect(server.live?.url).toBe('ws://fake:2');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(app.connection.restartNeeded).toBe(false);
  });
});

describe('client', () => {
  it('connect switches an open client to another service and resyncs', async () => {
    const server = new FakeServer();
    const client = new ServiceClient({ WebSocketImpl: server.Impl });
    await client.connect('ws://old:1', 'a');
    const reconnected = vi.fn();
    client.onReconnect(reconnected);

    await client.connect('ws://new:2', 'b');
    expect(client.status).toBe('open');
    expect(server.live?.url).toBe('ws://new:2');
    expect(server.sockets.filter((s) => s.open)).toHaveLength(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(server.protocols.at(-1)).toEqual(['pahub.b']);
  });
});
