import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * Cold start (spec §8, anti-goal 4): a first launch that cannot reach the
 * service yet must not be a dead end — the error offers Retry, and a failed
 * start is not remembered forever.
 */
const app = vi.hoisted(() => ({ startApp: vi.fn<() => Promise<void>>() }));
vi.mock('../../src/lib/state/app', () => ({ startApp: app.startApp }));

describe('start page', () => {
  it('shows the failure with a Retry that starts again', async () => {
    const { default: Page } = await import('../../src/routes/+page.svelte');
    app.startApp
      .mockRejectedValueOnce(new Error('service-start-timeout: no service answered'))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    render(Page);
    expect(await screen.findByText(/could not reach the pahub service/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(app.startApp).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/connecting/i)).toBeTruthy();
    expect(screen.queryByText(/could not reach/i)).toBeNull();
  }, 30_000);
});
