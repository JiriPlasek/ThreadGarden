import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import { text, tool, user } from './fixtures';

describe('concise message list', () => {
  it('keeps the conversation and finished agent summary without tool/thinking rows', async () => {
    const { container } = render(MessageList, {
      concise: true,
      items: [
        user('u', 'Find the issue'),
        { kind: 'thinking', id: 'think', text: 'private reasoning' },
        tool('read', 'Read', { file_path: '/tmp/source.ts' }),
        tool(
          'agent',
          'Agent',
          { description: 'Check the parser' },
          { resultText: 'Found the parser issue.' },
        ),
        text('a', 'Fixed the issue.'),
      ],
    });
    await waitFor(() => expect(container.textContent).toContain('Fixed the issue.'));
    expect(container.textContent).toContain('Find the issue');
    expect(container.textContent).toContain('Check the parser');
    expect(container.textContent).toContain('Found the parser issue.');
    expect(container.querySelector('[data-row="read"]')).toBeNull();
    expect(container.querySelector('[data-row="think"]')).toBeNull();
    expect(container.querySelector('[data-concise-task]')).toBeTruthy();
  });

  it('restores a scroll anchor on a task-only completion without a source item id', async () => {
    const at = 1_700_000_000_000;
    const items = Array.from({ length: 30 }, (_, i) =>
      user(`u${i}`, `Message ${i}`, { ts: at + i * 1000 }),
    );
    const memory = {
      heights: new Map(items.map((item) => [`concise-turn:${item.id}`, 60])),
      stick: false,
      anchor: { key: 'task-summary:finished', delta: 0 },
    };
    const { container } = render(MessageList, {
      concise: true,
      items,
      memory,
      fallbackHeight: 200,
      tasks: [
        {
          taskId: 'finished',
          kind: 'shell',
          description: 'Build complete',
          status: 'completed',
          startedAt: at + 9000,
          endedAt: at + 10000,
        },
      ],
    });
    await waitFor(() => expect(container.querySelector('[data-viewport]')?.scrollTop).toBe(540));
    expect(memory.anchor.key).toBe('task-summary:finished');
  });

  it('shows a working indicator when the hidden tool is the only visible progress', async () => {
    render(MessageList, {
      concise: true,
      working: true,
      items: [user('u'), tool('bash', 'Bash', { command: 'sleep 60' }, { status: 'running' })],
    });
    expect(await screen.findByRole('status', { name: /working|waiting for claude/i })).toBeTruthy();
  });
});
