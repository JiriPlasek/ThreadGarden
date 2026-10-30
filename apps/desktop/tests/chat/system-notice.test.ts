import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import SystemNotice from '../../src/lib/components/chat/items/SystemNotice.svelte';

describe('system notice', () => {
  it('an injected entry shows its short label, collapsed, and expands to the full text (R27)', async () => {
    const detail = '<task-notification>\n<status>completed</status>\n</task-notification>';
    render(SystemNotice, {
      item: {
        kind: 'system',
        id: 't1',
        level: 'info',
        text: 'Background command "npm test" completed (exit code 0)',
        detail,
      },
    });
    expect(screen.getByText('Background command "npm test" completed (exit code 0)')).toBeTruthy();
    expect(screen.queryByText(/<status>completed/)).toBeNull();
    const toggle = screen.getByRole('button', { name: /show details/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(screen.getByText(/<status>completed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /hide details/i })).toBeTruthy();
  });

  it('a plain system line has no details toggle', () => {
    render(SystemNotice, { item: { kind: 'system', id: 's', level: 'info', text: 'Compacted' } });
    expect(screen.getByText('Compacted')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
