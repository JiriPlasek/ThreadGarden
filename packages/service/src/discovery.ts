import { randomBytes } from 'node:crypto';
import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const DiscoverySchema = z.object({
  pid: z.number(),
  port: z.number(),
  token: z.string(),
  version: z.string(),
  protocolVersion: z.number(),
  startedAt: z.number(),
  /** v1.4, headless only: where the remote listener for paired devices listens. */
  remotePort: z.number().optional(),
  remoteAddresses: z.array(z.string()).optional(),
});
export type Discovery = z.infer<typeof DiscoverySchema>;

const discoveryPath = (dataDir: string) => join(dataDir, 'service.json');
const lockPath = (dataDir: string) => join(dataDir, 'service.lock');

export const writeDiscovery = async (dataDir: string, d: Discovery): Promise<void> => {
  const target = discoveryPath(dataDir);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(d), { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

export const readDiscovery = async (dataDir: string): Promise<Discovery | null> => {
  try {
    const raw: unknown = JSON.parse(await readFile(discoveryPath(dataDir), 'utf8'));
    const parsed = DiscoverySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const removeDiscovery = async (dataDir: string): Promise<void> => {
  await unlink(discoveryPath(dataDir)).catch(() => {});
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const readLockPid = async (file: string): Promise<number | null> => {
  const text = await readFile(file, 'utf8').catch(() => '');
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Single-instance lock. The pid is written to a temp file which is hard-linked onto the lock path,
 * so the lock appears atomically and is never observed empty. An unreadable lock is treated as held.
 */
export const acquireInstanceLock = async (
  dataDir: string,
): Promise<{ release(): Promise<void> } | null> => {
  const file = lockPath(dataDir);
  const mine = String(process.pid);
  const unique = () => `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const tmp = `${unique()}.tmp`;
  await writeFile(tmp, mine);
  try {
    let unreadable = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await link(tmp, file);
        return {
          release: async () => {
            if ((await readFile(file, 'utf8').catch(() => null)) === mine) {
              await unlink(file).catch(() => {});
            }
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const pid = await readLockPid(file);
      if (pid === null) {
        if (++unreadable >= 5) return null;
        await sleep(50);
        continue;
      }
      if (isAlive(pid)) return null;
      // Stale: only the holder of the takeover mutex may remove it, so a freshly created lock is never unlinked.
      const mutex = `${file}.takeover`;
      try {
        await link(tmp, mutex);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const age = Date.now() - ((await stat(mutex).catch(() => null))?.mtimeMs ?? Date.now());
        if (age > 10_000) await unlink(mutex).catch(() => {});
        await sleep(20);
        continue;
      }
      try {
        if ((await readLockPid(file)) === pid) await unlink(file).catch(() => {});
      } finally {
        await unlink(mutex).catch(() => {});
      }
    }
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
};
