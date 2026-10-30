import type { ChatItem } from '@pahub/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import ToolCallRow from '../../src/lib/components/chat/items/ToolCallRow.svelte';
import { setup, summary } from '../layout/harness';
import { manyItems, text, tool, unknownItem, user } from './fixtures';

const rows = (root: HTMLElement) => root.querySelectorAll('[data-row]');

describe('message list', () => {
  it('renders 5,000 items with fewer than 120 DOM rows', async () => {
    const { container } = render(MessageList, { items: manyItems(5000) });
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
    expect(rows(container).length).toBeLessThan(120);
    // A new list starts at the newest message.
    expect(container.textContent).toContain('answer number 4999');
    expect(container.textContent).not.toContain('question number 0');
  });

  it('Agent tool groups child items', async () => {
    const items: ChatItem[] = [
      user('u1', 'find the bug'),
      tool(
        't1',
        'Agent',
        { description: 'Explore the parser', subagent_type: 'Explore' },
        {
          toolUseId: 'tu-agent',
          status: 'running',
        },
      ),
      text('c1', 'looking at the parser', { parentToolUseId: 'tu-agent' }),
      tool('c2', 'Read', { file_path: '/src/parser.ts' }, { parentToolUseId: 'tu-agent' }),
      text('a1', 'main thread answer'),
    ];
    const { container } = render(MessageList, { items });
    await waitFor(() => expect(rows(container).length).toBe(3));

    const toggle = screen.getByRole('button', { name: /Explore the parser/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('2 steps');
    await userEvent.click(toggle);
    const group = screen.getByRole('group', { name: /subagent/i });
    expect(within(group).getByText('looking at the parser')).toBeTruthy();
    expect(within(group).getByText(/parser\.ts/)).toBeTruthy();
    // Children are not rendered again at the top level.
    expect(screen.getAllByText('looking at the parser')).toHaveLength(1);
  });

  it('unknown item shows raw JSON collapsed', async () => {
    const raw = { type: 'future_thing', payload: { answer: 42 } };
    const { container } = render(MessageList, {
      items: [user('u1'), unknownItem('x1', 'future_thing', raw)],
    });
    const toggle = await screen.findByRole('button', { name: /unrecognised item.*future_thing/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('"answer": 42');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('"answer": 42');
  });

  it('consecutive unknown items collapse into one expandable row (R12)', async () => {
    const { container } = render(MessageList, {
      items: [
        unknownItem('x1', 'alpha', { type: 'alpha', n: 1 }),
        unknownItem('x2', 'beta', { type: 'beta', n: 2 }),
        unknownItem('x3', 'gamma', { type: 'gamma', n: 3 }),
      ],
    });
    await waitFor(() => expect(rows(container).length).toBe(1));
    const toggle = screen.getByRole('button', { name: /3 unrecognised items/i });
    expect(container.textContent).not.toContain('"n": 1');
    await userEvent.click(toggle);
    for (const n of [1, 2, 3]) expect(container.textContent).toContain(`"n": ${n}`);
  });

  it('sticks to the bottom while streaming unless the user scrolled up', async () => {
    const items = manyItems(300);
    const { container, rerender } = render(MessageList, { items });
    const viewport = container.querySelector<HTMLElement>('[data-viewport]')!;
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    const bottom = viewport.scrollTop;

    await rerender({ items: [...items, text('new1', 'brand new')] });
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(bottom));
    expect(container.textContent).toContain('brand new');

    // The user scrolls up: new output no longer moves the view.
    viewport.scrollTop = 1000;
    await fireEvent.scroll(viewport);
    await rerender({ items: [...items, text('new1', 'brand new'), text('new2', 'newer')] });
    await new Promise((r) => setTimeout(r, 30));
    expect(viewport.scrollTop).toBe(1000);
  });

  it('asks for older items near the top', async () => {
    const onLoadOlder = vi.fn();
    const { container } = render(MessageList, {
      items: manyItems(300),
      hasMore: true,
      onLoadOlder,
    });
    const viewport = container.querySelector<HTMLElement>('[data-viewport]')!;
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    expect(onLoadOlder).not.toHaveBeenCalled();
    viewport.scrollTop = 0;
    await fireEvent.scroll(viewport);
    expect(onLoadOlder).toHaveBeenCalled();
  });
});

describe('scroll anchoring', () => {
  type Observed = { cb: ResizeObserverCallback; els: Set<Element> };
  const observers: Observed[] = [];
  let original: typeof ResizeObserver;

  beforeEach(() => {
    original = globalThis.ResizeObserver;
    class ControlledResizeObserver {
      o: Observed;
      constructor(cb: ResizeObserverCallback) {
        this.o = { cb, els: new Set() };
        observers.push(this.o);
      }
      observe(el: Element): void {
        this.o.els.add(el);
      }
      unobserve(el: Element): void {
        this.o.els.delete(el);
      }
      disconnect(): void {
        this.o.els.clear();
      }
    }
    globalThis.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;
    window.ResizeObserver = globalThis.ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = original;
    window.ResizeObserver = original;
    observers.length = 0;
  });

  /** Reports a height for every observed row (as the browser would after layout). */
  const measureAll = (height: (key: string) => number) => {
    for (const o of observers) {
      const entries = [...o.els]
        .filter((el) => el instanceof HTMLElement && el.dataset.row !== undefined)
        .map((el) => ({
          target: el,
          borderBoxSize: [{ blockSize: height((el as HTMLElement).dataset.row!) }],
        }));
      if (entries.length) o.cb(entries as unknown as ResizeObserverEntry[], o as never);
    }
  };

  it('keeps the visible row in place when rows are measured and older items prepended', async () => {
    const items = manyItems(300);
    const { container, rerender } = render(MessageList, { items, hasMore: true });
    const viewport = container.querySelector<HTMLElement>('[data-viewport]')!;
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));

    // Scroll somewhere in the middle and note which row is at the top.
    viewport.scrollTop = 3000;
    await fireEvent.scroll(viewport);
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
    const rowTop = (key: string) => {
      const el = container.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
      return Number(el.dataset.top);
    };
    const firstVisible = [...rows(container)]
      .map((el) => (el as HTMLElement).dataset.row!)
      .find((k) => rowTop(k) + 1 > viewport.scrollTop)!;
    const before = rowTop(firstVisible) - viewport.scrollTop;

    // Rendered rows turn out much taller than estimated.
    measureAll(() => 300);
    await waitFor(() => expect(rowTop(firstVisible) - viewport.scrollTop).toBe(before));

    // Older history arrives above.
    const older: ChatItem[] = Array.from({ length: 50 }, (_, i) => text(`old${i}`, `old ${i}`));
    await rerender({ items: [...older, ...items], hasMore: true });
    await waitFor(() => expect(rowTop(firstVisible) - viewport.scrollTop).toBe(before));
  });
});

describe('tool rows', () => {
  it('Edit tool renders a diff', async () => {
    const item = tool('e1', 'Edit', {
      file_path: '/src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;\n',
      new_string: 'const a = 1;\nconst b = 3;\n',
    });
    const { container } = render(ToolCallRow, { item });
    const toggle = screen.getByRole('button', { name: /Edit.*app\.ts/ });
    expect(toggle.textContent).toContain('+1');
    expect(toggle.textContent).toContain('−1');
    await userEvent.click(toggle);

    const del = container.querySelector('[data-diff="del"]')!;
    const add = container.querySelector('[data-diff="add"]')!;
    expect(del.textContent).toContain('const b = 2;');
    expect(add.textContent).toContain('const b = 3;');

    await userEvent.click(screen.getByRole('button', { name: /side by side/i }));
    expect(container.querySelector('[data-diff-mode="split"]')).toBeTruthy();
  });

  it('Bash shows the command and exit status; truncated output is flagged', async () => {
    const item = tool(
      'b1',
      'Bash',
      { command: 'npm test' },
      {
        status: 'error',
        resultText: 'Exit code 1\nFAIL',
        resultTruncated: true,
      },
    );
    render(ToolCallRow, { item });
    const toggle = screen.getByRole('button', { name: /Bash.*npm test/ });
    expect(toggle.textContent).toContain('exit 1');
    await userEvent.click(toggle);
    expect(screen.getByText(/output truncated/i)).toBeTruthy();
    expect(screen.getByText(/FAIL/)).toBeTruthy();
  });

  it('unknown tools show the name and compact JSON', () => {
    render(ToolCallRow, { item: tool('m1', 'mcp__db__query', { sql: 'select 1' }) });
    const toggle = screen.getByRole('button', { name: /mcp__db__query/ });
    expect(toggle.textContent).toContain('"sql":"select 1"');
  });
});

describe('chat view', () => {
  const streamingSetup = () =>
    setup((server) => {
      server.handlers['chat.open'] = (p) => ({
        summary: summary((p as { sessionId: string }).sessionId, { status: 'working', live: true }),
        header: { model: 'opus', permissionMode: 'default' },
        items: [user('u1', 'hi'), text('s1', 'Hel', { streaming: true })],
        hasMore: false,
        seq: 1,
      });
      server.handlers['chat.models'] = () => [
        {
          value: 'opus',
          displayName: 'Opus',
          description: '',
          supportedEffortLevels: ['low', 'high'],
        },
        { value: 'sonnet', displayName: 'Sonnet', description: '' },
      ];
      server.handlers['chat.resumeCommand'] = (p) => ({
        command: `claude --resume ${(p as { sessionId: string }).sessionId}`,
      });
      server.handlers['chat.setModel'] = () => ({});
      server.handlers['chat.end'] = () => ({});
      server.handlers['chat.fork'] = () => ({ sessionId: 'forked-1' });
    });

  it('streaming text updates one element', async () => {
    const { server, app, context } = await streamingSetup();
    await app.chats.open('s');
    const { container } = render(ChatView, { context, props: { sessionId: 's' } });
    const el = await waitFor(() => {
      const found = container.querySelector('[data-item-id="s1"]');
      expect(found?.textContent).toContain('Hel');
      return found!;
    });

    let seq = 1;
    for (const chunk of ['Hello', 'Hello wor', 'Hello world, **streaming**']) {
      server.push('chat.items', {
        sessionId: 's',
        seq: ++seq,
        items: [text('s1', chunk, { streaming: true })],
      });
    }
    await waitFor(() => expect(el.textContent).toContain('Hello world, streaming'));
    expect(container.querySelectorAll('[data-item-id="s1"]')).toHaveLength(1);
    expect(container.querySelector('[data-item-id="s1"]')).toBe(el);
    expect(el.querySelector('strong')?.textContent).toBe('streaming');
  });

  it('copy resume command copies claude --resume <id>', async () => {
    const writeText = vi.fn(async (text: string) => void text);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { app, context } = await streamingSetup();
    await app.chats.open('abc-123');
    render(ChatView, { context, props: { sessionId: 'abc-123' } });
    await userEvent.click(await screen.findByRole('button', { name: /copy resume command/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude --resume abc-123'));
  });

  it('header pickers change the model of a live chat', async () => {
    const { server, app, context } = await streamingSetup();
    await app.chats.open('s');
    render(ChatView, { context, props: { sessionId: 's' } });
    const model = await screen.findByRole('combobox', { name: /model/i });
    await waitFor(() => expect(within(model).getAllByRole('option').length).toBe(2));
    await userEvent.selectOptions(model, 'sonnet');
    await waitFor(() =>
      expect(server.calls('chat.setModel').at(-1)?.params).toEqual({
        sessionId: 's',
        value: 'sonnet',
      }),
    );
    const mode = screen.getByRole('combobox', { name: /permission mode/i });
    const modes = within(mode)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(modes).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
  });

  it('pickers are disabled for a history-only chat', async () => {
    const { app, context } = await setup();
    await app.chats.open('h');
    render(ChatView, { context, props: { sessionId: 'h' } });
    const model = await screen.findByRole('combobox', { name: /model/i });
    expect((model as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole('combobox', { name: /permission mode/i }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /end session/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('ending a working chat asks for confirmation', async () => {
    const { server, app, context } = await streamingSetup();
    await app.chats.open('s');
    render(ChatView, { context, props: { sessionId: 's' } });
    await userEvent.click(await screen.findByRole('button', { name: /end session/i }));
    expect(server.calls('chat.end')).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: /end anyway/i }));
    await waitFor(() => expect(server.calls('chat.end')).toHaveLength(1));
  });

  it('forks from a user message into a new tab', async () => {
    const { server, app, context } = await streamingSetup();
    await app.chats.open('s');
    render(ChatView, { context, props: { sessionId: 's' } });
    await userEvent.click(await screen.findByRole('button', { name: /fork from this message/i }));
    await waitFor(() =>
      expect(server.calls('chat.fork').at(-1)?.params).toEqual({
        sessionId: 's',
        upToItemId: 'u1',
      }),
    );
    await waitFor(() => expect(app.tabs.active).toBe('forked-1'));
  });
});
