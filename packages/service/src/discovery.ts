import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const DiscoverySchema = z.object({
  pid: z.number(),
  port: z.number(),
  token: z.string(),
  version: z.string(),
  protocolVersion: z.number(),
  startedAt: z.number(),
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

export const acquireInstanceLock = async (
  dataDir: string,
): Promise<{ release(): Promise<void> } | null> => {
  const file = lockPath(dataDir);
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(mine);
      await handle.close();
      return {
        release: async () => {
          const owner = await readFile(file, 'utf8').catch(() => null);
          if (owner === mine) await unlink(file).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return null;
    await unlink(file).catch(() => {});
  }
  return null;
};
