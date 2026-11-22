import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ServiceError } from '../server/router';

/** What Threadgarden knows about a project's MCP servers on disk. */
export interface McpProjectFiles {
  /** The keys of `<cwd>/.mcp.json`'s `mcpServers` (`[]` when missing or unreadable). */
  mcpJsonNames(cwd: string): Promise<string[]>;
  /** Adds the name to `<cwd>/.claude/settings.local.json`'s enabled list and takes it off the disabled list. */
  approve(cwd: string, name: string): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const localSettingsPath = (cwd: string): string => path.join(cwd, '.claude', 'settings.local.json');

const unique = (xs: string[]): string[] => [...new Set(xs)];

const chains = new Map<string, Promise<unknown>>();
/** Runs `fn` after every earlier job on the same file path. */
const serialised = <T>(file: string, fn: () => Promise<T>): Promise<T> => {
  const run = (chains.get(file) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(file, tail);
  void tail.then(() => {
    if (chains.get(file) === tail) chains.delete(file);
  });
  return run;
};

const approveNow = async (cwd: string, name: string): Promise<void> => {
  const file = localSettingsPath(cwd);
  let obj: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ServiceError(
        'SETTINGS_UNREADABLE',
        `${file} can't be read (${code}), so Threadgarden left it alone.`,
      );
    }
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      // A leading byte-order mark is dropped; the rewritten file has none.
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      throw new ServiceError(
        'SETTINGS_UNREADABLE',
        `${file} isn't valid JSON, so Threadgarden left it alone. Fix it, then approve again.`,
      );
    }
    obj = parsed;
  }
  obj.enabledMcpjsonServers = unique([...strings(obj.enabledMcpjsonServers), name]);
  if ('disabledMcpjsonServers' in obj) {
    obj.disabledMcpjsonServers = strings(obj.disabledMcpjsonServers).filter((n) => n !== name);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
};

export const diskProjectFiles: McpProjectFiles = {
  async mcpJsonNames(cwd) {
    const json = await readJson(path.join(cwd, '.mcp.json'));
    return isRecord(json) && isRecord(json.mcpServers) ? Object.keys(json.mcpServers) : [];
  },
  approve: (cwd, name) => serialised(localSettingsPath(cwd), () => approveNow(cwd, name)),
};
