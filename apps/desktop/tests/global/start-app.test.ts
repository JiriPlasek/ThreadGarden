import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  serviceConnection: vi.fn(async (): Promise<never> => {
    throw new Error('service-start-timeout: no service answered within 15 s');
  }),
}));
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  serviceConnection: native.serviceConnection,
}));

describe('startApp', () => {
  it('a failed start is not memoised: the next call tries again', async () => {
    const { startApp } = await import('../../src/lib/state/app');
    await expect(startApp()).rejects.toThrow(/service-start-timeout/);
    await expect(startApp()).rejects.toThrow(/service-start-timeout/);
    expect(native.serviceConnection).toHaveBeenCalledTimes(2);
  });
});
