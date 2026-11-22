import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { PROTOCOL_VERSION, SHELL_CAPABILITY } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import {
  fitImages,
  imageProblem,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
  mentionAt,
  mentionText,
  slashAt,
} from '../../src/lib/components/composer/input';
import { user } from '../chat/fixtures';
import { renderChat as renderMcpChat } from '../chat/mcp-harness';
import { LOCAL, machineInfo, project, setup } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';
import { CWD, fill, pushItems, pushStatus, renderChat, SID } from './helpers';

type SendParams = { sessionId: string; text: string; images?: unknown[] };

vi.mock('@xterm/xterm', () => import('../chat/fake-xterm'));
vi.mock('@xterm/addon-fit', () => import('../chat/fake-xterm'));

describe('composer', () => {
  const offerReply = (server: Parameters<typeof pushStatus>[0], seq = 2) =>
    server.push('chat.status', {
      sessionId: SID,
      seq,
      status: 'idle',
      promptSuggestion: { id: `prediction-${seq}`, text: 'Run the tests' },
    });

  it('shows a predicted reply as ghost text; Tab accepts and Enter sends', async () => {
    const { server, composer } = await renderChat();
    offerReply(server);
    await screen.findByRole('button', { name: 'Tab to accept suggestion' });
    expect(composer().textContent).toBe('');
    expect(server.calls('drafts.set')).toHaveLength(0);
    composer().focus();
    await userEvent.keyboard('{Enter}');
    expect(server.calls('chat.send')).toHaveLength(0);
    await userEvent.keyboard('{Tab}');
    expect(composer().textContent).toBe('Run the tests');
    expect(document.activeElement).toBe(composer());
    expect(server.calls('chat.send')).toHaveLength(0);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(server.calls('chat.send')[0]!.params).toEqual({ sessionId: SID, text: 'Run the tests' });
    await waitFor(() => expect(composer().textContent).toBe(''));
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
  });

  it('Escape dismisses a reply and it stays dismissed across remount and status updates', async () => {
    const { server, composer, view, context } = await renderChat();
    offerReply(server);
    await screen.findByRole('button', { name: 'Tab to accept suggestion' });
    composer().focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
    expect(server.calls('chat.interrupt')).toHaveLength(0);
    server.push('chat.status', {
      sessionId: SID,
      seq: 3,
      status: 'idle',
      promptSuggestion: { id: 'prediction-2', text: 'Run the tests' },
    });
    view.unmount();
    render(ChatView, { props: { ref: { machineId: LOCAL, sessionId: SID } }, context });
    await waitFor(() => expect(composer()).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
    offerReply(server, 4);
    expect(await screen.findByRole('button', { name: 'Tab to accept suggestion' })).toBeTruthy();
  });

  it('typing dismisses the prediction and an existing draft is never replaced', async () => {
    const { server, composer } = await renderChat();
    offerReply(server);
    await screen.findByRole('button', { name: 'Tab to accept suggestion' });
    await fill(composer(), 'My own reply');
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
    offerReply(server, 3);
    await waitFor(() => expect(composer().textContent).toBe('My own reply'));
    await fill(composer(), '');
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
  });

  it('Shift+Tab and composing Tab do not accept a suggestion; clicking accepts it', async () => {
    const { server, composer } = await renderChat();
    offerReply(server);
    const accept = await screen.findByRole('button', { name: 'Tab to accept suggestion' });
    composer().focus();
    await fireEvent.keyDown(composer(), { key: 'Tab', isComposing: true });
    await fireEvent.keyDown(composer(), { key: 'Tab', keyCode: 229 });
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(composer().textContent).toBe('');
    await userEvent.click(accept);
    expect(composer().textContent).toBe('Run the tests');
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('clears predictions when a new turn starts', async () => {
    const { server, composer } = await renderChat();
    offerReply(server);
    await screen.findByRole('button', { name: 'Tab to accept suggestion' });
    pushStatus(server, 3, 'working');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull(),
    );
    composer().focus();
    await userEvent.keyboard('{Tab}');
    expect(composer().textContent).toBe('');
  });

  it('Enter sends, Shift+Enter adds a line, and the box clears', async () => {
    const { server, composer } = await renderChat();
    await userEvent.type(composer(), 'first line{Shift>}{Enter}{/Shift}second line');
    expect(composer().textContent).toBe('first line\nsecond line');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(server.calls('chat.send')[0]!.params).toEqual({
      sessionId: SID,
      text: 'first line\nsecond line',
    });
    await waitFor(() => expect(composer().textContent).toBe(''));
  });

  it('Enter does not send while an IME composition is active', async () => {
    const { server, composer } = await renderChat();
    await userEvent.type(composer(), 'nihon');
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('with enterToSend off, Enter adds a line and Ctrl+Enter sends', async () => {
    const { app, server, composer } = await renderChat();
    app.settings.value = { ...app.settings.value, enterToSend: false };
    await userEvent.type(composer(), 'a{Enter}b');
    expect(composer().textContent).toBe('a\nb');
    expect(server.calls('chat.send')).toHaveLength(0);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
  });

  // One input event (`fill`) and more time: typing key by key here timed out
  // now and then under a loaded parallel run.
  it(
    'typing @sch shows schema.ts and inserts @src/lib/server/db/schema.ts',
    { timeout: 20_000 },
    async () => {
      const { server, composer } = await renderChat({
        configure: (s) => {
          s.handlers['files.suggest'] = () => [
            { path: 'src/lib/server/db/schema.ts', kind: 'file' },
            { path: 'src/lib/server/db', kind: 'dir' },
          ];
        },
      });
      await fill(composer(), 'look at @sch');
      const list = await screen.findByRole('listbox', { name: /files/i });
      const options = await within(list).findAllByRole('option');
      expect(options[0]!.textContent).toContain('schema.ts');
      expect(options[0]!.getAttribute('aria-selected')).toBe('true');
      expect(server.calls('files.suggest').at(-1)!.params).toMatchObject({
        cwd: CWD,
        query: 'sch',
      });
      expect(composer().getAttribute('aria-activedescendant')).toBe(options[0]!.id);

      await userEvent.keyboard('{Enter}');
      expect(composer().textContent).toBe('look at @src/lib/server/db/schema.ts ');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(server.calls('chat.send')).toHaveLength(0);
    },
  );

  it('mention picker navigates with arrows and closes with Esc', async () => {
    const { server, composer } = await renderChat({
      status: 'working',
      configure: (s) => {
        s.handlers['files.suggest'] = () => [
          { path: 'a.ts', kind: 'file' },
          { path: 'b.ts', kind: 'file' },
        ];
      },
    });
    await userEvent.type(composer(), '@');
    const list = await screen.findByRole('listbox', { name: /files/i });
    expect(await within(list).findAllByRole('option')).toHaveLength(2);
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    // Esc closed the picker; it did not interrupt the working chat.
    expect(server.calls('chat.interrupt')).toHaveLength(0);
    await userEvent.keyboard('{Tab}');
    expect(composer().textContent).toBe('@');
  });

  it('slash menu lists commands', async () => {
    const { server, composer } = await renderChat({
      configure: (s) => {
        s.handlers['chat.commands'] = () => [
          { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
          { name: 'compact', description: 'Compact the conversation', argumentHint: '' },
          { name: 'init', description: 'Create a CLAUDE.md', argumentHint: '' },
        ];
      },
    });
    await userEvent.type(composer(), '/');
    const list = await screen.findByRole('listbox', { name: /commands/i });
    // The SDK's commands come first, then Threadgarden's terminal-only table (R25).
    expect(
      within(list)
        .getAllByRole('option')
        .slice(0, 3)
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining('/review'),
      expect.stringContaining('/compact'),
      expect.stringContaining('/init'),
    ]);
    expect(server.calls('chat.commands')[0]!.params).toEqual({ sessionId: SID });

    await userEvent.type(composer(), 'comp');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Tab}');
    expect(composer().textContent).toBe('/compact ');
  });

  it('a message sent while working shows greyed out until Claude reads it', async () => {
    const { server, composer, app } = await renderChat({
      status: 'working',
      items: [user('u1', 'fix the build')],
    });
    await userEvent.type(composer(), 'and also check the docs');
    expect(screen.getByText(/claude reads it at its next step/i)).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    // The service lists it as queued: it follows the conversation, greyed out.
    const queued = [{ id: 'q1', text: 'and also check the docs', ts: 1 }];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    const bubble = await screen.findByRole('group', { name: /queued message/i });
    expect(within(bubble).getByText('and also check the docs').closest('.opacity-50')).toBeTruthy();
    // Not in the transcript yet, so there is nothing to fork from.
    expect(within(bubble).queryByRole('button', { name: /fork/i })).toBeNull();
    expect(screen.getByText(/1 message queued/i)).toBeTruthy();

    // Claude reads it at its next step: the same message, no longer greyed out.
    pushItems(server, 3, [user('q1', 'and also check the docs')]);
    server.push('chat.status', { sessionId: SID, seq: 4, status: 'working', queued: [] });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /queued message/i })).toBeNull(),
    );
    expect(screen.getByText('and also check the docs')).toBeTruthy();
    expect(screen.queryByText(/queued/i)).toBeNull();
    expect(app.chats.get(SID)?.items.map((i) => i.id)).toEqual(['u1', 'q1']);
  });

  it('a queued message with images says how many', async () => {
    const { server } = await renderChat({ status: 'working', items: [user('u1')] });
    const queued = [{ id: 'q1', text: 'like this', imageCount: 2, ts: 1 }];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    const bubble = await screen.findByRole('group', { name: /queued message/i });
    expect(within(bubble).getByText(/2 images/i)).toBeTruthy();
  });

  it('the queue does not outlive a status without one (an older service)', async () => {
    const { server } = await renderChat({ status: 'working', items: [user('u1')] });
    const queued = [{ id: 'q1', text: 'one', ts: 1 }];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    await screen.findByRole('group', { name: /queued message/i });
    pushStatus(server, 3, 'idle');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /queued message/i })).toBeNull(),
    );
  });

  it('a queued message has a Remove button that takes it back', async () => {
    const { server } = await renderChat({
      status: 'working',
      items: [user('u1')],
      configure: (s) => {
        s.handlers['chat.withdraw'] = () => ({ text: 'never mind' });
      },
    });
    const queued = [{ id: 'q1', text: 'never mind', ts: 1 }];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    const bubble = await screen.findByRole('group', { name: /queued message/i });
    await userEvent.click(within(bubble).getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(server.calls('chat.withdraw')).toHaveLength(1));
    expect(server.calls('chat.withdraw')[0]!.params).toEqual({ sessionId: SID, messageId: 'q1' });
  });

  it('Up in an empty composer takes the last queued message back to edit it', async () => {
    const img = { mediaType: 'image/png', data: 'AAAA', number: 1 };
    const { server, composer } = await renderChat({
      status: 'working',
      items: [user('u1')],
      configure: (s) => {
        s.handlers['chat.withdraw'] = () => ({
          text: 'second, reworded [Image #1]',
          images: [img],
        });
      },
    });
    const queued = [
      { id: 'q1', text: 'first', ts: 1 },
      { id: 'q2', text: 'second', ts: 2 },
    ];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    await screen.findAllByRole('group', { name: /queued message/i });
    expect(screen.getByText(/edits the last one/i)).toBeTruthy();
    composer().focus();
    await userEvent.keyboard('{ArrowUp}');
    // Into an empty box it comes back with its own image number.
    await waitFor(() => expect(composer().textContent).toBe('second, reworded [Image #1]'));
    expect(server.calls('chat.withdraw')[0]!.params).toEqual({ sessionId: SID, messageId: 'q2' });
    expect(screen.getByRole('img', { name: /attached image 1/i })).toBeTruthy();
    // Up in a box with text moves the caret, as usual.
    await userEvent.keyboard('{ArrowUp}');
    expect(server.calls('chat.withdraw')).toHaveLength(1);
  });

  it('Up says so when Claude has read the last queued message already', async () => {
    const { server, composer } = await renderChat({
      status: 'working',
      items: [user('u1')],
      configure: (s) => {
        s.handlers['chat.withdraw'] = () => {
          throw new RpcFail('NOT_QUEUED', 'Claude has already read this message');
        };
      },
    });
    const queued = [{ id: 'q1', text: 'first', ts: 1 }];
    server.push('chat.status', { sessionId: SID, seq: 2, status: 'working', queued });
    await screen.findByRole('group', { name: /queued message/i });
    composer().focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(await screen.findByText(/already read this message/i)).toBeTruthy();
    expect(composer().textContent).toBe('');
  });

  it('queued messages given back (Stop) go in front of the draft, images too', async () => {
    const img = { mediaType: 'image/png', data: 'AAAA', number: 1 };
    const { server, composer } = await renderChat({ status: 'working', items: [user('u1')] });
    await userEvent.type(composer(), 'half-typed');
    server.push('messagesReturned', {
      sessionId: SID,
      messages: [{ text: 'one' }, { text: 'two [Image #1]', images: [img] }],
    });
    // Next to the draft's text, a given-back image gets a number of the box's own.
    await waitFor(() => expect(composer().textContent).toBe('one\ntwo [Image #2]\nhalf-typed'));
    expect(screen.getByRole('img', { name: /attached image 2/i })).toBeTruthy();
    // Another chat's are not this one's.
    server.push('messagesReturned', { sessionId: 'other', messages: [{ text: 'elsewhere' }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(composer().textContent).toBe('one\ntwo [Image #2]\nhalf-typed');
  });

  it('a given-back image never takes the number of one already in the box', async () => {
    const theirs = { mediaType: 'image/png', data: 'THEIRS', number: 1 };
    const { server, composer } = await renderChat({ status: 'working', items: [user('u1')] });
    const pasted = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    composer().focus();
    await fireEvent.paste(composer(), { clipboardData: { files: [pasted], items: [] } });
    await waitFor(() => expect(composer().textContent).toBe('[Image #1]'));
    server.push('messagesReturned', {
      sessionId: SID,
      messages: [{ text: 'look [Image #1]', images: [theirs] }],
    });
    await waitFor(() => expect(composer().textContent).toBe('look [Image #2]\n[Image #1]'));
    expect(screen.getByRole('img', { name: /attached image 1/i })).toBeTruthy();
    expect(screen.getByRole('img', { name: /attached image 2/i })).toBeTruthy();
  });

  it('draft survives remount', async () => {
    const stored = new Map<string, string>();
    const { server, composer, view, context } = await renderChat({
      configure: (s) => {
        s.handlers['drafts.get'] = (p) => ({ text: stored.get((p as { key: string }).key) ?? '' });
        s.handlers['drafts.set'] = (p) => {
          const { key, text } = p as { key: string; text: string };
          stored.set(key, text);
          return {};
        };
      },
    });
    await userEvent.type(composer(), 'half-written thought');
    await waitFor(() => expect(stored.get(SID)).toBe('half-written thought'), { timeout: 1500 });
    const sets = server.calls('drafts.set').length;
    expect(sets).toBeLessThanOrEqual(2); // debounced, not one write per keystroke

    view.unmount();
    render(ChatView, { props: { ref: { machineId: LOCAL, sessionId: SID } }, context });
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: /message/i }) as HTMLDivElement).textContent,
      ).toBe('half-written thought'),
    );
  });

  it('a pending draft is written when the composer unmounts', async () => {
    const { server, composer, view } = await renderChat();
    await userEvent.type(composer(), 'quick');
    view.unmount();
    await waitFor(() =>
      expect(server.calls('drafts.set').at(-1)?.params).toEqual({ key: SID, text: 'quick' }),
    );
  });

  it('Esc interrupts', async () => {
    const { server, composer } = await renderChat({ status: 'working' });
    await userEvent.click(composer());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(server.calls('chat.interrupt')).toHaveLength(1));
    expect(server.calls('chat.interrupt')[0]!.params).toEqual({ sessionId: SID });

    await userEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    await waitFor(() => expect(server.calls('chat.interrupt')).toHaveLength(2));
  });

  it('pasted images are attached and sent; oversized ones are refused', async () => {
    const { server, composer } = await renderChat();
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    const huge = new File([new Uint8Array(8)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: MAX_IMAGE_BYTES + 1 });
    fireEvent.paste(composer(), { clipboardData: { files: [png, huge], items: [] } });
    const thumbs = await screen.findByRole('list', { name: /attached images/i });
    await waitFor(() => expect(within(thumbs).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toMatch(/at most 5 MB/);

    await userEvent.type(composer(), 'what is this?{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    const sent = server.calls('chat.send')[0]!.params as SendParams;
    expect(sent.images).toEqual([{ mediaType: 'image/png', data: 'iVBORw==', number: 1 }]);
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: /attached images/i })).toBeNull(),
    );
  });
});

describe('/mcp', () => {
  const field = () => screen.getByRole('textbox', { name: /message/i }) as HTMLDivElement;

  it('/mcp opens the MCP dialog and is not sent', async () => {
    const env = await renderMcpChat();
    await userEvent.type(field(), '/mcp{Escape}{Enter}');
    expect(await screen.findByText('MCP servers (this chat)')).toBeTruthy();
    expect(field().textContent).toBe('');
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('/mcp is intercepted even when the SDK reports it', async () => {
    const env = await renderMcpChat({
      commands: [{ name: 'mcp', description: 'Manage MCP servers', argumentHint: '' }],
    });
    await userEvent.type(field(), '/mcp{Escape}{Enter}');
    expect(await screen.findByText('MCP servers (this chat)')).toBeTruthy();
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('/mcp in a Codex chat says why', async () => {
    const env = await renderMcpChat({ sessionId: 'codex-1' });
    await userEvent.type(field(), '/mcp{Escape}{Enter}');
    expect(await screen.findByText('MCP servers are for Claude chats.')).toBeTruthy();
    expect(screen.queryByText('MCP servers (this chat)')).toBeNull();
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('/mcp on a machine without mcp says to update it', async () => {
    await renderMcpChat({ capabilities: ['remote'] });
    await userEvent.type(field(), '/mcp{Escape}{Enter}');
    expect(await screen.findByText('Update This PC to manage MCP servers from here.')).toBeTruthy();
  });
});

describe('! command mode', () => {
  const field = () => screen.getByRole('textbox', { name: /message/i }) as HTMLDivElement;
  const LABEL = "Runs in a terminal on This PC, in this chat's folder";
  const shellChat = (sessionId?: string) =>
    renderMcpChat({
      ...(sessionId ? { sessionId } : {}),
      capabilities: ['remote', SHELL_CAPABILITY],
      configure: (s) => {
        s.handlers['shell.start'] = (p) => ({
          runId: 'r1',
          sessionId: 's1',
          command: (p as { command: string }).command,
          cwd: '/work/alpha',
          cols: 100,
          rows: 24,
          startedAt: Date.now(),
          state: 'running',
        });
      },
    });
  const started = (server: Parameters<typeof pushStatus>[0]) =>
    server.calls('shell.start').map((c) => (c.params as { command: string }).command);

  it('a leading ! turns on command mode and sends the command, not a message', async () => {
    const env = await shellChat();
    await userEvent.type(field(), '  ');
    expect(field().closest('[data-command-mode]')).toBeNull();
    await userEvent.type(field(), '!');
    const box = field().closest('[data-command-mode]') as HTMLElement;
    expect(box).not.toBeNull();
    expect(within(box).getByTitle(LABEL).textContent?.trim()).toBe('!');
    await userEvent.type(field(), ' git status{Enter}');
    await waitFor(() => expect(started(env.server)).toEqual(['git status']));
    expect(env.server.calls('chat.send')).toHaveLength(0);
    await waitFor(() => expect(field().textContent).toBe(''));
    expect(field().closest('[data-command-mode]')).toBeNull();
  });

  it('images and image tags are left out; pasted text runs', async () => {
    const env = await shellChat();
    const pasted = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n');
    await fill(field(), '! cat');
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(field(), { clipboardData: { files: [png], items: [] } });
    await waitFor(() => expect(field().textContent).toBe('! cat [Image #1]'));
    fireEvent.paste(field(), {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? pasted : ''),
      },
    });
    await waitFor(() => expect(field().textContent).toContain('[Pasted text #1 +9 lines]'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(started(env.server)).toHaveLength(1));
    expect(started(env.server)[0]).toBe(`cat  ${pasted}`);
    expect(env.server.calls('shell.start')[0]!.params).not.toHaveProperty('images');
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: /attached images/i })).toBeNull(),
    );
  });

  it('! alone says Type a command after !', async () => {
    const env = await shellChat();
    await userEvent.type(field(), '!{Enter}');
    expect(
      (await screen.findByRole('status', { name: 'Command notice' })).textContent?.trim(),
    ).toBe('Type a command after !');
    expect(env.server.calls('shell.start')).toHaveLength(0);
    expect(env.server.calls('chat.send')).toHaveLength(0);
  });

  it('without onCommand a leading ! is sent as text (Codex)', async () => {
    const env = await shellChat('codex-1');
    await userEvent.type(field(), '!');
    expect(field().closest('[data-command-mode]')).toBeNull();
    await userEvent.type(field(), ' ls{Enter}');
    await waitFor(() => expect(env.server.calls('chat.send')).toHaveLength(1));
    expect((env.server.calls('chat.send')[0]!.params as SendParams).text).toBe('! ls');
    expect(env.server.calls('shell.start')).toHaveLength(0);
  });

  it('without onCommand a leading ! is sent as text (New chat)', async () => {
    const { server, app, context } = await setup((s) => {
      Object.assign(s.handlers, {
        hello: () => ({
          serviceVersion: '0.1.0',
          protocolVersion: PROTOCOL_VERSION,
          machine: machineInfo(LOCAL, 'my-host', ['remote', SHELL_CAPABILITY]),
        }),
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => [],
        'chat.commands': () => [],
        'files.suggest': () => [],
        'chat.create': () => ({ sessionId: 'new-1' }),
      });
    });
    await app.places.refresh();
    app.interaction.openNewChat('/work/alpha');
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const box = within(dialog).getByRole('textbox', { name: /message/i });
    await userEvent.type(box, '! ls');
    expect(box.closest('[data-command-mode]')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toMatchObject({ text: '! ls' });
    expect(server.calls('shell.start')).toHaveLength(0);
  });

  it('/ inside a command opens no slash menu', async () => {
    await shellChat();
    await userEvent.type(field(), '!/');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('listbox')).toBeNull();
    await fill(field(), '! /usr/bin/env');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('composer helpers', () => {
  it('finds the mention and command under the caret', () => {
    expect(mentionAt('see @src/li now', 11)).toEqual({ start: 4, end: 11, query: 'src/li' });
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(slashAt('/rev', 4)).toEqual({ start: 0, end: 4, query: 'rev' });
    expect(slashAt('/review 12', 10)).toBeNull();
    expect(slashAt('a /review', 9)).toBeNull();
  });

  it('formats mentions like the CLI', () => {
    expect(mentionText('src/a.ts', 'file')).toBe('@src/a.ts ');
    expect(mentionText('src/lib', 'dir')).toBe('@src/lib/');
    expect(mentionText('my docs/a.md', 'file')).toBe('@"my docs/a.md" ');
  });

  it('caps the images of one message so the request always fits (never a silent drop)', () => {
    // base64 of n bytes: ceil(n / 3) * 4 characters, `=`-padded.
    const img = (bytes: number) => {
      const pad = (3 - (bytes % 3)) % 3;
      return {
        mediaType: 'image/png',
        data: 'A'.repeat(Math.ceil(bytes / 3) * 4 - pad) + '='.repeat(pad),
      };
    };
    const five = 5 * 1024 * 1024;
    const kept = [img(five), img(five), img(five)];
    const r = fitImages(kept, [img(five), img(five)]);
    expect(r.accepted).toHaveLength(1);
    expect(r.problem).toMatch(/1 image was not attached/);
    expect(r.problem).toMatch(/20 MB/);
    expect(fitImages([], [img(10)])).toEqual({ accepted: [img(10)], problem: null });
    expect(MAX_MESSAGE_IMAGE_BYTES).toBe(4 * five);
  });

  it('accepts only small PNG, JPEG, GIF and WebP images', () => {
    expect(imageProblem({ name: 'a.webp', type: 'image/webp', size: 10 })).toBeNull();
    expect(imageProblem({ name: 'a.bmp', type: 'image/bmp', size: 10 })).toMatch(/PNG/);
    expect(imageProblem({ name: 'a.gif', type: 'image/gif', size: MAX_IMAGE_BYTES + 1 })).toMatch(
      /5 MB/,
    );
  });
});
