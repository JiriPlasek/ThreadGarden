import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallKind, UpdateHandle, Updater } from '../../src/lib/native';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UpdatesState,
} from '../../src/lib/state/updates.svelte';

type Calls = string[];

const handle = (
  version: string,
  calls: Calls,
  opts: { failDownload?: boolean } = {},
): UpdateHandle => ({
  version,
  notes: `Notes for ${version}`,
  download: async (onProgress) => {
    calls.push('download');
    if (opts.failDownload) throw new Error('signature mismatch');
    onProgress(50, 100);
    onProgress(100, 100);
  },
  install: async () => {
    calls.push('install');
  },
});

/** A fake updater: `next` is what the next check finds (a version, null, or an error). */
const fakeUpdater = (calls: Calls, kind: InstallKind = 'windows') => {
  const state: { next: string | null | Error; failDownload: boolean; checks: number } = {
    next: null,
    failDownload: false,
    checks: 0,
  };
  const updater: Updater = {
    check: async () => {
      state.checks++;
      if (state.next instanceof Error) throw state.next;
      return state.next === null
        ? null
        : handle(state.next, calls, { failDownload: state.failDownload });
    },
    relaunch: async () => {
      calls.push('relaunch');
    },
    installKind: async () => kind,
  };
  return { updater, state };
};

/** The local service's uiState, in memory. */
const fakeApi = (stored: Record<string, unknown> = {}) => ({
  stored,
  request: (async (method: string, params: { key: string; value?: unknown }) => {
    if (method === 'uiState.get') return { value: stored[params.key] ?? null };
    if (method === 'uiState.set') {
      stored[params.key] = params.value;
      return {};
    }
    throw new Error(`unexpected ${method}`);
  }) as never,
});

const flush = () => vi.advanceTimersByTimeAsync(0);

let updates: UpdatesState;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  updates?.dispose();
  vi.useRealTimers();
});

const start = async (opts: { kind?: InstallKind; stored?: Record<string, unknown> } = {}) => {
  const calls: Calls = [];
  const { updater, state } = fakeUpdater(calls, opts.kind);
  const api = fakeApi(opts.stored);
  updates = new UpdatesState();
  updates.init({
    api,
    updater,
    appVersion: '0.3.0',
    stopLocalService: async () => {
      calls.push('stopLocalService');
    },
  });
  await flush();
  return { calls, state, api };
};

describe('UpdatesState', () => {
  it('checks 10 s after start, then every 6 hours', async () => {
    const { state } = await start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(state.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(state.checks).toBe(2);
    expect(FIRST_CHECK_DELAY_MS).toBe(10_000);
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60_000);
  });

  it('shows an available update', async () => {
    const { state } = await start();
    state.next = '0.3.1';
    await updates.check();
    expect(updates.phase).toBe('available');
    expect(updates.available).toEqual({ version: '0.3.1', notes: 'Notes for 0.3.1' });
    expect(updates.current).toBe('0.3.0');
    expect(updates.lastCheck).not.toBeNull();
  });

  it('stays quiet when a scheduled check cannot reach GitHub, and keeps checking', async () => {
    const { state } = await start();
    state.next = new Error('offline');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updates.lastError).toBeNull();
    expect(updates.phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(state.checks).toBe(2);
  });

  it('says so when a manual check cannot reach GitHub', async () => {
    const { state } = await start();
    state.next = new Error('offline');
    await updates.check({ manual: true });
    expect(updates.lastError).toBe("Couldn't reach GitHub. Try again later.");
    expect(updates.phase).toBe('idle');
  });

  it('remembers a dismissed version across restarts, and shows the next one', async () => {
    const first = await start();
    first.state.next = '0.3.1';
    await updates.check();
    updates.dismiss();
    await flush();
    expect(updates.dismissed).toBe(true);
    expect(first.api.stored['updates.dismissed']).toBe('0.3.1');
    updates.dispose();

    const again = await start({ stored: first.api.stored });
    again.state.next = '0.3.1';
    await updates.check();
    expect(updates.dismissed).toBe(true);
    again.state.next = '0.3.2';
    await updates.check();
    expect(updates.dismissed).toBe(false);
  });

  it('downloads first, then stops the local service, installs and relaunches', async () => {
    const { calls, state } = await start();
    state.next = '0.3.1';
    await updates.check();
    await updates.install();
    expect(calls).toEqual(['download', 'stopLocalService', 'install', 'relaunch']);
  });

  it('changes nothing when the download fails or does not verify', async () => {
    const { calls, state } = await start();
    state.next = '0.3.1';
    state.failDownload = true;
    await updates.check();
    await updates.install();
    expect(calls).toEqual(['download']);
    expect(updates.lastError).toBe(
      "The update couldn't be downloaded or verified. Nothing was changed.",
    );
    expect(updates.phase).toBe('available');
  });

  it('cannot update deb and rpm installs by itself', async () => {
    await start({ kind: 'linux-package' });
    expect(updates.canSelfUpdate).toBe(false);
  });

  it('does nothing outside the desktop app', async () => {
    const { state } = await start({ kind: 'unsupported' });
    expect(updates.phase).toBe('unsupported');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(state.checks).toBe(0);
  });
});
