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

  it('a chat another process holds says so, with End the process right beside it', async () => {
    const { server } = await renderChat({
      status: 'idle',
      summary: { external: { ...terminal, status: 'idle' } },
      configure: (s) => {
        s.handlers['external.stop'] = () => ({});
      },
    });
    const note = screen.getByText(/running in another claude code process/i);
    const button = screen.getByRole('button', { name: /end the process/i });
    // Next to the note, not among the header's icon buttons.
    expect(note.parentElement).toBe(button.parentElement);
    expect(screen.queryByRole('button', { name: /stop background session/i })).toBeNull();
    const end = screen.getByRole('button', { name: /end session/i }) as HTMLButtonElement;
    expect(end.disabled).toBe(true);
    await userEvent.click(button);
    expect(server.calls('external.stop')).toHaveLength(0);
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/any running turn/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls('external.stop')).toHaveLength(0);
    await userEvent.click(button);
    dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /end process/i }));
    await waitFor(() => expect(server.calls('external.stop')).toHaveLength(1));
    expect(server.calls('external.stop')[0]!.params).toEqual({ sessionId: SID });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls('chat.end')).toHaveLength(0);
  });

  it('a busy one asks before End the process ends it', async () => {
    const { server } = await renderChat({
      status: 'working',
      summary: { external: terminal },
      configure: (s) => {
        s.handlers['external.stop'] = () => ({});
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /end the process/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(server.calls('external.stop')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: /end process/i }));
    await waitFor(() => expect(server.calls('external.stop')).toHaveLength(1));
  });

  it("Threadgarden's own live chat still has End session and live pickers", async () => {
    await renderChat({ status: 'idle' });
    expect(
      (screen.getByRole('button', { name: /end session/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('combobox', { name: /permission mode/i }) as HTMLSelectElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/another claude code process/i)).toBeNull();
  });
});
