/**
 * What the service asks GitHub: the newest release's version. Everything it
 * fetches is checked here: HTTPS only, from GitHub's own hosts.
 */
import { UPDATE_ERRORS, VERSION_PATTERN } from '@threadgarden/protocol';
import { ServiceError } from '../server/router.js';

export type Fetch = typeof fetch;

export const LATEST_URL =
  'https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/latest.json';
const MAX_REDIRECTS = 5;
/** How long a successful answer is kept (GitHub rate-limits anonymous callers). */
const DEFAULT_TTL_MS = 10 * 60_000;
/** A blackholed connection must not leave a request pending for ever. */
const DEFAULT_TIMEOUT_MS = 15_000;

const unreachable = (message: string): ServiceError =>
  new ServiceError(UPDATE_ERRORS.UNREACHABLE, message);

/** GitHub itself, and the hosts it serves release files from (`*.githubusercontent.com`). */
const hostAllowed = (host: string): boolean =>
  host === 'github.com' || host.endsWith('.githubusercontent.com');

const parseChecked = (url: string): URL => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw unreachable('Not a valid URL');
  }
  if (u.protocol !== 'https:') throw unreachable('Only https is allowed');
  if (!hostAllowed(u.hostname)) throw unreachable(`${u.hostname} is not a GitHub host`);
  return u;
};

/**
 * GETs `url`, following redirects by hand so that every hop is checked (the
 * built-in follower would go anywhere). Anything wrong is `UNREACHABLE`.
 */
export const fetchChecked = async (
  url: string,
  deps: { fetch: Fetch },
  opts: { timeoutMs?: number } = {},
): Promise<Response> => {
  let current = parseChecked(url);
  // One budget for the whole request: every redirect, and the caller reading
  // the body (the signal stays live after we return). A downloader passes more.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (let hops = 0; ; hops++) {
    let res: Response;
    try {
      res = await deps.fetch(current.href, { redirect: 'manual', signal });
    } catch (err) {
      throw unreachable(`Could not reach ${current.hostname}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw unreachable('A redirect without a location');
      if (hops >= MAX_REDIRECTS) throw unreachable('Too many redirects');
      await res.body?.cancel();
      current = parseChecked(new URL(location, current).href);
      continue;
    }
    if (!res.ok) throw unreachable(`${current.hostname} answered ${res.status}`);
    return res;
  }
};

/** The newest release's version, cached for a while; a failure is never cached. */
export class LatestRelease {
  private cached: { version: string; at: number } | undefined;

  constructor(
    private readonly deps: { fetch: Fetch; now: () => number; ttlMs?: number; timeoutMs?: number },
  ) {}

  async get(): Promise<string> {
    const { now } = this.deps;
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    if (this.cached && now() - this.cached.at < ttl) return this.cached.version;
    const res = await fetchChecked(LATEST_URL, this.deps, {
      ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
    });
    let body: unknown;
    try {
      // A body that stalls past the budget is aborted by the request's signal.
      body = await res.json();
    } catch {
      throw unreachable('latest.json could not be read as JSON (or took too long)');
    }
    const version = (body as { version?: unknown } | null)?.version;
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      throw unreachable('latest.json has no usable version');
    }
    this.cached = { version, at: now() };
    return version;
  }
}
