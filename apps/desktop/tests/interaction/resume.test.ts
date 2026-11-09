import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RpcFail } from '../service/fake-ws';
import { renderChat, SID } from './helpers';

const resumeAnswer =
  (status: string, reason = '', recentlyModified = false, canStop = true) =>
  () => ({
    status,
    reason,
    recentlyModified,
    canStop,
  });

describe('resume safety (spec §4.4)', () => {
  it('blocked resume shows copy command and does not send', async () => {
    const { server, composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer(
          'blocked',
          'This chat is open in a terminal (pid 4242).',
        );
      },
    });
    await userEvent.type(composer(), 'continue please{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This chat is open in a terminal (pid 4242).');
    expect(server.calls('chat.resumeCheck')[0]!.params).toEqual({ sessionId: SID });
    expect(server.calls('chat.send')).toHaveLength(0);
    // The message is kept for later.
    expect(composer().textContent).toBe('continue please');

    await userEvent.click(within(alert).getByRole('button', { name: /copy resume command/i }));
    await waitFor(() => expect(server.calls('chat.resumeCommand')).toHaveLength(1));
    expect(within(alert).getByText(`claude --resume ${SID}`)).toBeTruthy();
  });

  it.each([
    'This chat is running in another Claude Code process (pid 4242).',
    'This chat is running as a background session.',
  ])('confirms stopping from the banner: %s', async (reason) => {
    const { server, composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer('blocked', reason);
        s.handlers['external.stop'] = () => ({});
      },
    });
    await userEvent.type(composer(), 'continue please{Enter}');
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: /end the process/i }));
    let confirmation = await screen.findByRole('alertdialog');
    expect(server.calls('external.stop')).toHaveLength(0);
    expect(confirmation.textContent).toMatch(/background tasks or a dev server/);
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls('external.stop')).toHaveLength(0);
    expect(alert.textContent).toContain(reason);
    await userEvent.click(within(alert).getByRole('button', { name: /end the process/i }));
    confirmation = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirmation).getByRole('button', { name: /end process/i }));
    await waitFor(() => expect(server.calls('external.stop')).toHaveLength(1));
    expect(server.calls('external.stop')[0]!.params).toEqual({ sessionId: SID });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    // Press Enter again to send it here.
    expect(composer().value).toBe('continue please');
  });

  it('a failed End the process stays in the confirmation dialog', async () => {
    const { composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer('blocked', 'Running in pid 4242.');
        s.handlers['external.stop'] = () => {
          throw new RpcFail('STOP_FAILED', 'Process 4242 is still running.');
        };
      },
    });
    await userEvent.type(composer(), 'x{Enter}');
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: /end the process/i }));
    const confirmation = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirmation).getByRole('button', { name: /end process/i }));
    expect(await within(confirmation).findByText(/process 4242 is still running/i)).toBeTruthy();
  });

  it('hides End the process when the fresh resume check has no stoppable holder', async () => {
    const { composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer(
          'blocked',
          'No process id is available.',
          false,
          false,
        );
      },
    });
    await userEvent.type(composer(), 'go{Enter}');
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: /end the process/i })).toBeNull();
    expect(within(alert).getByRole('button', { name: /copy resume command/i })).toBeTruthy();
  });

  it('unverified resume asks confirmation', async () => {
    const { server, composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer('unverified', 'claude agents is unavailable');
      },
    });
    await userEvent.type(composer(), 'go on{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/can.t check whether this chat is open elsewhere/i);
    expect(server.calls('chat.send')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: /continue here/i }));
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(server.calls('chat.send')[0]!.params).toEqual({ sessionId: SID, text: 'go on' });
  });

  it('a recently modified transcript is mentioned and confirmed', async () => {
    const { server, composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.resumeCheck'] = resumeAnswer('ok', '', true);
      },
    });
    await userEvent.type(composer(), 'go on{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/last 2 minutes/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls('chat.send')).toHaveLength(0);
    expect(composer().textContent).toBe('go on');
  });

  it('ok resume sends at once; live chats skip the check', async () => {
    const history = await renderChat({ status: 'history' });
    await userEvent.type(history.composer(), 'hi{Enter}');
    await waitFor(() => expect(history.server.calls('chat.send')).toHaveLength(1));
    history.view.unmount();

    const live = await renderChat({ status: 'idle' });
    await userEvent.type(live.composer(), 'hi{Enter}');
    await waitFor(() => expect(live.server.calls('chat.send')).toHaveLength(1));
    expect(live.server.calls('chat.resumeCheck')).toHaveLength(0);
  });

  it('a server-side RESUME_BLOCKED (race) shows the reason too', async () => {
    const { composer } = await renderChat({
      status: 'history',
      configure: (s) => {
        s.handlers['chat.send'] = () => {
          throw new RpcFail('RESUME_BLOCKED', 'Started in a terminal a moment ago.');
        };
      },
    });
    await userEvent.type(composer(), 'x{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Started in a terminal a moment ago.');
    expect(within(alert).getByRole('button', { name: /copy resume command/i })).toBeTruthy();
  });
});
