import { describe, expect, it } from 'vitest';
import { fetchChecked, LatestRelease, type Fetch } from '../../src/update/github.js';
import { registerUpdateHandlers } from '../../src/server/handlers/update.js';
import { Router } from '../../src/server/router.js';

const LATEST = 'https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/latest.json';

const redirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

/** A fake `fetch` answering from a script, one response per call; it records the URLs. */
const scripted = (...answers: (Response | Error)[]): { fetch: Fetch; urls: string[] } => {
  const urls: string[] = [];
  const fetch: Fetch = async (input) => {
    urls.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, urls };
};

describe('fetchChecked', () => {
  it('follows a redirect to release-assets.githubusercontent.com', async () => {
    const s = scripted(
      redirect('https://release-assets.githubusercontent.com/abc/latest.json'),
      json({ version: '1.0.0' }),
    );
    const res = await fetchChecked(LATEST, { fetch: s.fetch });
    expect(await res.json()).toEqual({ version: '1.0.0' });
    expect(s.urls[1]).toBe('https://release-assets.githubusercontent.com/abc/latest.json');
  });

  it('refuses a redirect to example.com', async () => {
    const s = scripted(redirect('https://example.com/latest.json'), json({ version: '1.0.0' }));
    await expect(fetchChecked(LATEST, { fetch: s.fetch })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
    expect(s.urls).toHaveLength(1);
  });

  it('refuses http://', async () => {
    const s = scripted(json({}));
    await expect(
      fetchChecked('http://github.com/x/latest.json', { fetch: s.fetch }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(s.urls).toHaveLength(0);
  });

  it('refuses a redirect down to http://', async () => {
    const s = scripted(redirect('http://github.com/x'));
    await expect(fetchChecked(LATEST, { fetch: s.fetch })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
  });

  it('refuses a host that merely ends like githubusercontent.com', async () => {
    const s = scripted(redirect('https://evilgithubusercontent.com/x'));
    await expect(fetchChecked(LATEST, { fetch: s.fetch })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
  });

  it.each(['x.githubusercontent.com.evil.com', 'github.com.evil.com'])(
    'refuses the lookalike host %s, at the start and in a redirect',
    async (host) => {
      const direct = scripted(json({}));
      await expect(
        fetchChecked(`https://${host}/latest.json`, { fetch: direct.fetch }),
      ).rejects.toMatchObject({ code: 'UNREACHABLE' });
      expect(direct.urls).toHaveLength(0);

      const hop = scripted(redirect(`https://${host}/latest.json`), json({}));
      await expect(fetchChecked(LATEST, { fetch: hop.fetch })).rejects.toMatchObject({
        code: 'UNREACHABLE',
      });
      expect(hop.urls).toEqual([LATEST]);
    },
  );

  it('follows a relative redirect on the same host', async () => {
    const s = scripted(redirect('/elsewhere/latest.json'), json({ version: '1.0.0' }));
    const res = await fetchChecked(LATEST, { fetch: s.fetch });
    expect(await res.json()).toEqual({ version: '1.0.0' });
    expect(s.urls[1]).toBe('https://github.com/elsewhere/latest.json');
  });

  it('refuses a 3xx with no location', async () => {
    const s = scripted(new Response(null, { status: 302 }), json({}));
    await expect(fetchChecked(LATEST, { fetch: s.fetch })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
    expect(s.urls).toHaveLength(1);
  });

  it('stops after 5 redirects', async () => {
    const hop = () => redirect('https://github.com/next');
    const six = scripted(hop(), hop(), hop(), hop(), hop(), hop(), json({}));
    await expect(fetchChecked(LATEST, { fetch: six.fetch })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
    expect(six.urls).toHaveLength(6);
    // Exactly 5 redirects are fine.
    const five = scripted(hop(), hop(), hop(), hop(), hop(), json({ ok: true }));
    expect((await fetchChecked(LATEST, { fetch: five.fetch })).status).toBe(200);
  });

  it('turns a network error and a non-2xx status into UNREACHABLE', async () => {
    await expect(
      fetchChecked(LATEST, { fetch: scripted(new Error('offline')).fetch }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
    await expect(
      fetchChecked(LATEST, { fetch: scripted(new Response('no', { status: 404 })).fetch }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

/** A fake fetch that honours the signal like the real one: it rejects when aborted. */
const abortable = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

describe('timeouts', () => {
  it('a request that never answers is UNREACHABLE after the timeout', async () => {
    const hang: Fetch = (_url, init) => abortable(init?.signal);
    const started = Date.now();
    await expect(fetchChecked(LATEST, { fetch: hang }, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('one budget covers the redirects too', async () => {
    let calls = 0;
    const slow: Fetch = async (_url, init) => {
      if (++calls === 1) {
        await new Promise((r) => setTimeout(r, 60));
        return redirect('https://github.com/next');
      }
      return abortable(init?.signal);
    };
    await expect(fetchChecked(LATEST, { fetch: slow }, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'UNREACHABLE',
    });
  });

  it('a body that stalls is UNREACHABLE', async () => {
    const stalls: Fetch = async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    const latest = new LatestRelease({ fetch: stalls, now: () => 0, timeoutMs: 30 });
    await expect(latest.get()).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

describe('LatestRelease', () => {
  it('reads version from latest.json and caches it for 10 minutes', async () => {
    let now = 1_000;
    const s = scripted(json({ version: '0.8.0' }), json({ version: '0.9.0' }));
    const latest = new LatestRelease({ fetch: s.fetch, now: () => now });
    expect(await latest.get()).toBe('0.8.0');
    expect(s.urls).toEqual([LATEST]);
    now += 9 * 60_000;
    expect(await latest.get()).toBe('0.8.0');
    expect(s.urls).toHaveLength(1);
    now += 2 * 60_000;
    expect(await latest.get()).toBe('0.9.0');
    expect(s.urls).toHaveLength(2);
  });

  it('a failed latest is not cached', async () => {
    const s = scripted(new Error('offline'), json({ version: '0.8.0' }));
    const latest = new LatestRelease({ fetch: s.fetch, now: () => 0 });
    await expect(latest.get()).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(await latest.get()).toBe('0.8.0');
  });

  it('a version failing VERSION_PATTERN is UNREACHABLE', async () => {
    for (const version of ['../evil', '', '.hidden', 'a/b', 7, undefined]) {
      const latest = new LatestRelease({ fetch: scripted(json({ version })).fetch, now: () => 0 });
      await expect(latest.get()).rejects.toMatchObject({ code: 'UNREACHABLE' });
    }
    const notJson = new LatestRelease({
      fetch: scripted(new Response('<html>', { status: 200 })).fetch,
      now: () => 0,
    });
    await expect(notJson.get()).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

describe('update.latest', () => {
  const make = () => {
    const router = new Router();
    const s = scripted(json({ version: '0.8.0' }));
    registerUpdateHandlers(router, {
      latest: new LatestRelease({ fetch: s.fetch, now: () => 0 }),
      updater: {
        supported: () => false,
        status: () => ({ state: 'idle' }),
        start: async () => ({ started: true }),
        reconcile: async () => {},
      },
      supported: () => false,
    });
    return router;
  };

  it('answers a local client with the version', async () => {
    const res = await make().dispatch(
      { id: 1, method: 'update.latest', params: {} },
      { clientId: 'c', origin: 'local' },
    );
    expect(res).toMatchObject({ result: { version: '0.8.0' } });
  });

  it('update.latest is local-only', async () => {
    const res = await make().dispatch(
      { id: 1, method: 'update.latest', params: {} },
      { clientId: 'c', origin: 'remote' },
    );
    expect(res).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
