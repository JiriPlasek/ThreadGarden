/**
 * v1.2 C1, Ruling R33: the title query runs with `settingSources: []` (no
 * settings files, hooks or CLAUDE.md), while the user's sessions load the
 * user, project and local settings. Those settings can route requests: an
 * `env` block (a gateway's `ANTHROPIC_BASE_URL`, Bedrock/Vertex switches,
 * proxies) or credential helpers. When any of them is set, a title query
 * could go around the provider the user chose, so it is not sent at all.
 *
 * The files are only read (never written); a file is read again only when
 * its modification time or size changed. A missing file routes nothing; a
 * file that cannot be read as a JSON object counts as routing (skip).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Settings keys that can change where or how a session's requests go. */
export const ROUTING_KEYS = [
  'env',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
] as const;

/** The settings files a session in `cwd` loads: user, project, local. */
export const routingSettingsPaths = (claudeConfigDir: string, cwd: string): string[] => [
  join(claudeConfigDir, 'settings.json'),
  join(cwd, '.claude', 'settings.json'),
  join(cwd, '.claude', 'settings.local.json'),
];

type FsDeps = {
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  readFile: (path: string) => Promise<string>;
};

const nodeFs: FsDeps = {
  stat: (p) => stat(p),
  readFile: (p) => readFile(p, 'utf8'),
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A value that sets something: not absent, null, '' or an empty object. */
const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && !(isRecord(v) && Object.keys(v).length === 0);

const missing = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export class RoutingSettingsCheck {
  private readonly fs: FsDeps;
  /** Per file: its `mtime:size` when last read, and what it said. */
  private readonly cache = new Map<string, { key: string; reason: string | undefined }>();

  constructor(fs: Partial<FsDeps> = {}) {
    this.fs = { ...nodeFs, ...fs };
  }

  /** Why a title query could route differently from the sessions, else undefined. */
  async check(paths: readonly string[]): Promise<string | undefined> {
    for (const p of paths) {
      const reason = await this.one(p);
      if (reason) return reason;
    }
    return undefined;
  }

  private async one(path: string): Promise<string | undefined> {
    let st: { mtimeMs: number; size: number };
    try {
      st = await this.fs.stat(path);
    } catch (err) {
      if (missing(err)) return undefined;
      return `${path} could not be read`;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(path);
    if (hit?.key === key) return hit.reason;
    let reason: string | undefined;
    try {
      const json: unknown = JSON.parse((await this.fs.readFile(path)).replace(/^\uFEFF/, ''));
      if (!isRecord(json)) throw new Error('not an object');
      const routing = ROUTING_KEYS.find((k) => isSet(json[k]));
      reason = routing === undefined ? undefined : `${path} sets ${routing}`;
    } catch {
      reason = `${path} is not valid JSON settings`;
    }
    this.cache.set(path, { key, reason });
    return reason;
  }
}
