import { afterEach, describe, expect, it, vi } from 'vitest';

// Desktop mode: the Tauri runtime is present and the opener plugin opens URLs (ruling R23).
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (url: string) => void url) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

describe('openExternal (desktop)', () => {
  afterEach(() => {
    openUrl.mockClear();
    vi.restoreAllMocks();
  });

  it('opens http(s) URLs in the system browser through the opener plugin', async () => {
    const native = await import('../src/lib/native');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(native.isTauri).toBe(true);
    await expect(native.openExternal('https://example.com/a?b=1')).resolves.toBe(true);
    await expect(native.openExternal('HTTP://example.com')).resolves.toBe(true);
    // Normalised (lower-case scheme) so the capability's `http(s)://*` scope matches.
    expect(openUrl.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/a?b=1',
      'http://example.com/',
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores every other kind of target', async () => {
    const native = await import('../src/lib/native');
    for (const url of [
      'javascript:alert(1)',
      'mailto:a@b.example',
      'file:///etc/passwd',
      '/relative/path',
      'example.com',
      'https://',
      '',
    ]) {
      await expect(native.openExternal(url)).resolves.toBe(false);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });
});
