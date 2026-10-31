import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RpcFail } from '../service/fake-ws';
import { renderChat, SID } from './helpers';

const background = { kind: 'background', shortId: 'abc12345', state: 'blocked' };
const terminal = { kind: 'interactive', pid: 4242, status: 'busy' };

describe('chats running outside Threadgarden', () => {
  it('a background session gets Stop, which runs external.stop after confirming', async () => {
    const { server } = await renderChat({
      status: 'needsYou',
      summary: { external: background },
      configure: (s) => {
        s.handlers['external.stop'] = () => ({});
      },
    });
    expect(screen.queryByRole('button', { name: /end session/i })).toBeNull();
    expect(
      (screen.getByRole('combobox', { name: /permission mode/i }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/running in claude code's background service/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /stop background session/i }));
    expect(server.calls('external.stop')).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /stop session/i }));
    await waitFor(() => expect(server.calls('external.stop')).toHaveLength(1));
    expect(server.calls('external.stop')[0]!.params).toEqual({ sessionId: SID });
    expect(server.calls('chat.end')).toHaveLength(0);
  });

  it('a failed stop is shown, not swallowed', async () => {
    await renderChat({
      status: 'working',
      summary: { external: background },
      configure: (s) => {
        s.handlers['external.stop'] = () => {
          throw new RpcFail('STOP_FAILED', 'claude stop abc12345 failed: exit 1');
        };
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /stop background session/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /stop session/i }));
    expect(await within(dialog).findByText(/claude stop abc12345 failed/i)).toBeTruthy();
  });

  it('a terminal session says to stop it there and offers no stop', async () => {
    const { server } = await renderChat({ status: 'working', summary: { external: terminal } });
    expect(screen.getByText(/running in a terminal — stop it there/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop background session/i })).toBeNull();
    const end = screen.getByRole('button', { name: /end session/i }) as HTMLButtonElement;
    expect(end.disabled).toBe(true);
    await userEvent.click(end);
    expect(server.calls('chat.end')).toHaveLength(0);
  });

  it("Threadgarden's own live chat still has End session and live pickers", async () => {
    await renderChat({ status: 'idle' });
    expect(
      (screen.getByRole('button', { name: /end session/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('combobox', { name: /permission mode/i }) as HTMLSelectElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/stop it there/i)).toBeNull();
  });
});
