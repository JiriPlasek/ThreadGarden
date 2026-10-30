import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RpcFail } from '../service/fake-ws';
import { renderChat, SID } from './helpers';

const resumeAnswer =
  (status: string, reason = '', recentlyModified = false) =>
  () => ({
    status,
    reason,
    recentlyModified,
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
    expect(composer().value).toBe('continue please');

    await userEvent.click(within(alert).getByRole('button', { name: /copy resume command/i }));
    await waitFor(() => expect(server.calls('chat.resumeCommand')).toHaveLength(1));
    expect(within(alert).getByText(`claude --resume ${SID}`)).toBeTruthy();
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
    expect(composer().value).toBe('go on');
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
