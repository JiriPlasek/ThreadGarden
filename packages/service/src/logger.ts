import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type Logger = {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  flush(): Promise<void>;
};

const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;

/** Rotating file logger. `debug` (the only level that may carry message content) is off unless enabled. */
export const createLogger = (dataDir: string, opts: { debug?: boolean } = {}): Logger => {
  const dir = join(dataDir, 'logs');
  const current = join(dir, 'service.log');
  const numbered = (i: number) => join(dir, `service.${i}.log`);
  let size: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  const rotate = async () => {
    await unlink(numbered(MAX_FILES - 1)).catch(() => {});
    for (let i = MAX_FILES - 2; i >= 1; i--) {
      await rename(numbered(i), numbered(i + 1)).catch(() => {});
    }
    await rename(current, numbered(1)).catch(() => {});
    size = 0;
  };

  const write = (line: string) => {
    queue = queue
      .then(async () => {
        await mkdir(dir, { recursive: true });
        if (size === null) size = (await stat(current).catch(() => null))?.size ?? 0;
        if (size >= MAX_BYTES) await rotate();
        await appendFile(current, line);
        size = (size ?? 0) + Buffer.byteLength(line);
      })
      .catch(() => {});
  };

  const log = (level: string) => (msg: string) =>
    write(`${new Date().toISOString()} ${level} ${msg}\n`);

  return {
    debug: opts.debug ? log('debug') : () => {},
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    flush: () => queue,
  };
};
