import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import { mentionForPath, pastedPathMention } from '../../src/lib/components/composer/drop';
import { setup } from '../layout/harness';
import { bashRequest, renderChat, request, SID } from './helpers';

const MODELS = [
  {
    value: 'opus',
    displayName: 'Opus',
    description: '',
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  { value: 'sonnet', displayName: 'Sonnet', description: '' },
];

const liveChat = (commands: unknown[] = []) =>
  renderChat({
    status: 'idle',
    configure: (s) => {
      s.handlers['chat.commands'] = () => commands;
      s.handlers['chat.models'] = () => MODELS;
    },
  });

describe('terminal-only slash commands (ruling R25)', () => {
  it('lists terminal-only commands as unavailable and does not send them', async () => {
    const { server, composer } = await liveChat([
      { name: 'review', description: 'Review a pull request', argumentHint: '' },
    ]);
    await userEvent.type(composer(), '/con');
    const list = await screen.findByRole('listbox', { name: /commands/i });
    const config = within(list).getByRole('option', { name: /\/config/ });
    expect(config.getAttribute('aria-disabled')).toBe('true');
    expect(config.textContent).toMatch(/unavailable in pahub/i);

    // Picking it shows the notice instead of inserting it.
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status', { name: /command notice/i }).textContent).toMatch(
      /\/config is unavailable in pahub/i,
    );
    expect(composer().value).toBe('/con');

    await userEvent.clear(composer());
    await userEvent.type(composer(), '/login{Escape}{Enter}');
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls('chat.send')).toHaveLength(0);
    expect(screen.getByRole('status', { name: /command notice/i }).textContent).toMatch(
      /\/login is unavailable in pahub/i,
    );
    expect(composer().value).toBe('/login');
  });

  it('/model opens the model picker instead of sending', async () => {
    const { server, composer } = await liveChat();
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Opus' }).length).toBe(1));
    await userEvent.type(composer(), '/mod');
    const list = await screen.findByRole('listbox', { name: /commands/i });
    expect(
      within(list)
        .getByRole('option', { name: /\/model/ })
        .getAttribute('aria-disabled'),
    ).not.toBe('true');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Model' })),
    );
    expect(composer().value).toBe('');
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('/permissions and /effort typed in full focus their pickers', async () => {
    const { server, composer } = await liveChat();
    await userEvent.type(composer(), '/permissions{Escape}{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('combobox', { name: 'Permission mode' }),
      ),
    );
    expect(composer().value).toBe('');
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('commands the SDK reports as supported take precedence', async () => {
    const { server, composer } = await liveChat([
      { name: 'model', description: 'Switch the model', argumentHint: '[model]' },
    ]);
    await userEvent.type(composer(), '/model{Escape}{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(server.calls('chat.send')[0]!.params).toMatchObject({ text: '/model' });
  });
});

describe('dropped and pasted paths (ruling R24)', () => {
  it('maps paths inside the chat folder to relative mentions', () => {
    expect(mentionForPath('/work/alpha/src/app.ts', '/work/alpha')).toBe('@src/app.ts ');
    expect(mentionForPath('/elsewhere/My Notes.md', '/work/alpha')).toBe(
      '@"/elsewhere/My Notes.md" ',
    );
    expect(mentionForPath('/work/alphabet/x.ts', '/work/alpha')).toBe('@/work/alphabet/x.ts ');
    expect(mentionForPath('c:\\Work\\Alpha\\src\\a.ts', 'C:\\work\\alpha')).toBe('@src/a.ts ');
    expect(mentionForPath('D:\\other\\b.ts', 'C:\\work\\alpha')).toBe('@D:\\other\\b.ts ');
    expect(pastedPathMention('/work/alpha/src/lib/x.ts', '/work/alpha')).toBe('@src/lib/x.ts ');
    expect(pastedPathMention('/elsewhere/x.ts', '/work/alpha')).toBeNull();
    expect(pastedPathMention('see /work/alpha/x.ts', '/work/alpha')).toBeNull();
    expect(pastedPathMention('/work/alpha/a\n/work/alpha/b', '/work/alpha')).toBeNull();
  });

  it('pasting an absolute path inside the project inserts a mention', async () => {
    const { composer } = await renderChat();
    await userEvent.type(composer(), 'look at ');
    const paste = createEvent.paste(composer(), {
      clipboardData: { getData: () => '/work/alpha/src/lib/x.ts', files: [], items: [] },
    });
    fireEvent(composer(), paste);
    expect(paste.defaultPrevented).toBe(true);
    await waitFor(() => expect(composer().value).toBe('look at @src/lib/x.ts '));
  });
});

describe('stray file drops never navigate the window', () => {
  it('the window cancels file dragover and drop', async () => {
    const { context } = await setup();
    render(AppShell, { context });
    await screen.findByRole('navigation', { name: 'Places' });
    for (const make of [createEvent.dragOver, createEvent.drop]) {
      const e = make(window, { dataTransfer: { types: ['Files'], files: [] } });
      fireEvent(window, e);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('the composer cancels every file drop, explaining non-images', async () => {
    const { composer } = await renderChat();
    const pdf = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' });
    const e = createEvent.drop(composer(), {
      dataTransfer: { types: ['Files'], files: [pdf], items: [] },
    });
    fireEvent(composer(), e);
    expect(e.defaultPrevented).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toMatch(/spec\.pdf/);
  });
});

describe('in-chat setup notice', () => {
  it('sits above a usable composer and can be dismissed', async () => {
    const { server, composer } = await renderChat({
      status: 'failed',
      items: [
        {
          kind: 'system',
          id: 'x1',
          level: 'error',
          text: 'Claude Code needs an update: too old.',
          setup: true,
        },
      ],
    });
    const region = await screen.findByRole('region', { name: /update claude code/i });
    // Sending again retries (after updating Claude Code).
    await userEvent.type(composer(), 'try again{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    await userEvent.click(within(region).getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('region', { name: /update claude code/i })).toBeNull();
  });
});

describe('answers are given once', () => {
  it('a card stays disabled after a successful answer until the service settles it', async () => {
    const { server } = await renderChat({
      status: 'needsYou',
      items: [
        bashRequest(),
        request({
          requestId: 'r2',
          id: 'perm:r2',
          toolName: 'ExitPlanMode',
          variant: 'plan',
          input: { plan: 'do it' },
        }),
        request({
          requestId: 'r3',
          id: 'perm:r3',
          toolName: 'AskUserQuestion',
          variant: 'question',
          input: {
            questions: [
              {
                question: 'Which?',
                header: 'Pick',
                multiSelect: false,
                options: [
                  { label: 'A', description: '' },
                  { label: 'B', description: '' },
                ],
              },
            ],
          },
        }),
      ],
    });
    const allow = await screen.findByRole('button', { name: /^allow$/i });
    await userEvent.click(allow);
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(allow);

    const approve = screen.getByRole('button', { name: /^approve$/i });
    await userEvent.click(approve);
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(2));
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('radio', { name: /^a/i }));
    const answer = screen.getByRole('button', { name: /^answer$/i });
    await userEvent.click(answer);
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(3));
    expect((answer as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(answer);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls('chat.respond')).toHaveLength(3);
  });
});

describe('sending keeps what was typed meanwhile', () => {
  it('text typed while a send is in flight is not wiped', async () => {
    let release: (v: unknown) => void = () => {};
    const { composer } = await renderChat({
      configure: (s) => {
        s.handlers['chat.send'] = () => new Promise((r) => (release = r));
      },
    });
    await userEvent.type(composer(), 'first{Enter}');
    await userEvent.type(composer(), ' and more');
    release({ queued: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(composer().value).toBe('first and more');
  });

  it('the box clears when nothing changed during the send', async () => {
    let release: (v: unknown) => void = () => {};
    const { composer, server } = await renderChat({
      configure: (s) => {
        s.handlers['chat.send'] = () => new Promise((r) => (release = r));
      },
    });
    await userEvent.type(composer(), 'only this{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    release({ queued: false });
    await waitFor(() => expect(composer().value).toBe(''));
    expect(SID).toBe('s1');
  });
});
