import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PowerConfigSchema, type PowerConfig } from '@threadgarden/protocol';
import { z } from 'zod';

const FILE = 'power-switch.json';

const StoredSchema = z.object({ config: PowerConfigSchema, password: z.string() });

/**
 * A headless machine's copy of its power switch's configuration, with the switch's
 * web password: `<dataDir>/power-switch.json`, readable by its owner only.
 * Nothing else may expose the password.
 */
export class PowerStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, FILE);
  }

  /** What is stored, or null when nothing is or the file cannot be read. */
  load(): { config: PowerConfig; password: string } | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = StoredSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Stores `config` (the stored password stays when none is given); `null` removes everything. */
  save(config: PowerConfig | null, password?: string): void {
    if (config === null) {
      rmSync(this.file, { force: true });
      rmSync(`${this.file}.tmp`, { force: true });
      return;
    }
    const pw = password ?? this.load()?.password;
    if (pw === undefined) throw new Error('A power configuration needs a password');
    // Written beside the file and renamed over it: a crash never leaves half a file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ config, password: pw }), { mode: 0o600 });
    // `mode` only applies to a new file; an existing one keeps its old mode.
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
