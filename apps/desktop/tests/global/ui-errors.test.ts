import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeError, installErrorReporting, makeReporter } from '../../src/lib/ui-errors';
import BoundaryHarness from './BoundaryHarness.svelte';

describe('reporting the window’s errors', () => {
  it('describes an Error with its name, message and stack', () => {
    const e = new TypeError('x is undefined');
    const d = describeError(e);
    expect(d.message).toBe('TypeError: x is undefined');
    expect(d.stack).toContain('x is undefined');
  });

  it('sends ui.error to the service and never throws, even when the service is gone', async () => {
    const request = vi.fn().mockRejectedValue(new Error('closed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = makeReporter(request);
    expect(() => report('render', new Error('boom'))).not.toThrow();
    expect(request).toHaveBeenCalledWith(
      'ui.error',
      expect.objectContaining({ where: 'render', message: 'Error: boom' }),
    );
    await Promise.resolve();
    err.mockRestore();
  });

  it('reports uncaught window errors and unhandled rejections', () => {
    const report = vi.fn();
    const stop = installErrorReporting(window, report);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late' }));
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: 'nope' });
    window.dispatchEvent(rejection);
    stop();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after stop' }));
    expect(report.mock.calls.map((c) => c[0])).toEqual(['window', 'promise']);
  });
});

describe('the app-wide error boundary', () => {
  it('shows "Something went wrong" with Reload instead of a dead page, and reports it', async () => {
    const report = vi.fn();
    const reload = vi.fn();
    render(BoundaryHarness, { props: { report, reload } });
    expect(screen.getByText('fine')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Break' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain('Error: broken on purpose');
    expect(report).toHaveBeenCalledWith('render', expect.any(Error));
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
