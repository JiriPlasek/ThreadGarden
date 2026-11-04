/**
 * A headless machine updating itself: what the owner did by hand over SSH.
 * Downloads a release, checks it and unpacks it, then hands over to the apply
 * script in a systemd unit of its own, because the install restarts this service.
 *
 * Everything that must outlive that restart is in `<dataDir>/update/`:
 * - `pending.json`: `{version, from}`, the update handed over to the script;
 * - `skipped`: the sudo steps install.sh left out, one per line;
 * - `last.json`: how the last update ended (a `done` or `failed` `UpdateStatus`);
 * - `<version>/`: the download;
 * - `apply.sh` and `install.log`: the script, and what the install printed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  SkippedStepSchema,
  UPDATE_ERRORS,
  UpdateStatusSchema,
  VERSION_PATTERN,
  type SkippedStep,
  type UpdateFailure,
  type UpdateStage,
  type UpdateStartResult,
  type UpdateStatus,
} from '@threadgarden/protocol';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { ServiceError } from '../server/router.js';
import { APPLY_SCRIPT, applyArgs } from './apply-script.js';
import { fetchChecked, type Fetch } from './github.js';

const RELEASES = 'https://github.com/JiriPlasek/ThreadGarden/releases/download';
/** The whole tarball over a slow line; `fetchChecked`'s default is for small answers. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** `tar` on a slow disk is the longest of these; none of them ever asks for input. */
const RUN_TIMEOUT_MS = 5 * 60_000;
/** The status carries a reason for the card; the service log has the rest. */
const DETAIL_MAX_CHARS = 200;

export type Run = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs a command. A failure to run at all is a non-zero code too, with the reason in `stderr`. */
export const runCommand: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr: err && !stderr ? err.message : stderr });
    });
  });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const shortDetail = (text: string): string =>
  (text.trim().split('\n')[0] ?? '').trim().slice(0, DETAIL_MAX_CHARS);

/** A name systemd accepts: `VERSION_PATTERN` allows `+`, which a unit name does not. */
const unitName = (version: string): string =>
  `threadgarden-update-${version.replace(/[^A-Za-z0-9:_.-]/g, '_')}`;

const PendingSchema = z.object({
  version: z.string().regex(VERSION_PATTERN),
  from: z.string().regex(VERSION_PATTERN),
});
type Pending = z.infer<typeof PendingSchema>;

/** Only an update's end is ever written to `last.json`. */
const LastSchema = UpdateStatusSchema.refine((s) => s.state === 'done' || s.state === 'failed');

export type UpdaterDeps = {
  dataDir: string;
  currentVersion: string;
  /** Holds the release directories and `current` (default the one install.sh uses). */
  installBase?: string;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default `process.arch`. */
  arch?: NodeJS.Architecture;
  fetch: Fetch;
  /** Default `runCommand`: `tar`, `systemd-run` and `systemctl`. */
  run?: Run;
  /** How many chats an update would stop. */
  busyCount: () => Promise<number>;
  emit: (s: UpdateStatus) => void;
  log: Pick<Logger, 'warn' | 'error'>;
};

export class MachineUpdater {
  private readonly updateDir: string;
  private readonly installBase: string;
  private readonly run: Run;
  /**
   * This process's own knowledge: the update it is running, or how one ended
   * when `last.json` couldn't say so. Otherwise the files are the status.
   */
  private memory: UpdateStatus | undefined;
  /** Between a start's first check and the update being under way. */
  private starting = false;
  private reconciling: Promise<void> = Promise.resolve();
  /** `status` can be asked often: a bad file is logged once. */
  private readonly warned = new Set<string>();

  constructor(private readonly deps: UpdaterDeps) {
    this.updateDir = path.join(deps.dataDir, 'update');
    this.installBase =
      deps.installBase ?? path.join(os.homedir(), '.local', 'share', 'threadgarden-headless');
    this.run = deps.run ?? runCommand;
  }

  /**
   * An install this updater can replace: on x64 Linux, the only package released,
   * with install.sh's `current` in place.
   */
  supported(): boolean {
    return (
      (this.deps.platform ?? process.platform) === 'linux' &&
      (this.deps.arch ?? process.arch) === 'x64' &&
      existsSync(path.join(this.installBase, 'current'))
    );
  }

  status(): UpdateStatus {
    if (this.memory) return this.memory;
    const last = this.readLast();
    if (last) return last;
    const pending = this.readPending();
    return pending
      ? { state: 'running', version: pending.version, from: pending.from, stage: 'restarting' }
      : { state: 'idle' };
  }

  /** Answers once the update is under way; it goes on from there and reports through `emit`. */
  async start(version: string, force: boolean): Promise<UpdateStartResult> {
    if (!VERSION_PATTERN.test(version)) {
      throw new ServiceError(UPDATE_ERRORS.INVALID_VERSION, 'That is not a release version');
    }
    if (version === this.deps.currentVersion) {
      throw new ServiceError(UPDATE_ERRORS.ALREADY_CURRENT, `This machine already runs ${version}`);
    }
    if (this.starting || this.status().state === 'running') {
      throw new ServiceError(UPDATE_ERRORS.UPDATE_RUNNING, 'An update is already running');
    }
    this.starting = true;
    try {
      // It sweeps downloads away, so this one begins after it.
      await this.reconciling;
      if (!force) {
        const busy = await this.deps.busyCount();
        if (busy > 0) return { started: false, busy };
      }
      this.stage(version, 'downloading');
      void this.perform(version);
      return { started: true };
    } finally {
      this.starting = false;
    }
  }

  /**
   * Runs once this service has finished starting and can be reached (ruling R6): an
   * update waiting for that ends here. `done` is what the apply script waits for, so
   * a version that dies before this point never writes it, and is rolled back. Never
   * rejects.
   */
  reconcile(): Promise<void> {
    this.reconciling = this.settle().catch((err: unknown) =>
      this.deps.log.error(`update reconcile: ${errorText(err)}`),
    );
    return this.reconciling;
  }

  private async settle(): Promise<void> {
    if (this.starting || this.memory?.state === 'running') return;
    const pending = this.readPending();
    if (pending) {
      const here = pending.version === this.deps.currentVersion;
      // The script is still at work: what happens next comes with its restart.
      if (!here && (await this.unitActive(pending.version))) return;
      const last = this.readLast();
      // The script's own outcome says more than anything that can be told from here.
      if (last?.state !== 'failed' || last.version !== pending.version) {
        await this.finish(pending, here);
      }
      await rm(this.file('pending.json'), { force: true });
    }
    await rm(this.file('skipped'), { force: true });
    await this.removeDownloads();
  }

  private async finish(pending: Pending, here: boolean): Promise<void> {
    const { version, from } = pending;
    let outcome: UpdateStatus;
    if (here) {
      outcome = { state: 'done', version, from, skipped: await this.readSkipped() };
    } else {
      // A power cut, or the unit killed: nothing is left to end this update.
      const detail = `The update to ${version} stopped before it finished`;
      this.deps.log.error(`update: ${detail}; still running ${this.deps.currentVersion}`);
      outcome = { state: 'failed', version, from, reason: 'install', detail };
      // So it never reads as running, even if the file can't be written. A `done`
      // that can't be written stays unsaid: the script has to roll that one back.
      this.memory = outcome;
    }
    await this.writeFileAtomic('last.json', JSON.stringify(outcome));
    this.tell(outcome);
  }

  private async unitActive(version: string): Promise<boolean> {
    try {
      const r = await this.run('systemctl', ['--user', 'is-active', unitName(version)]);
      return r.code === 0;
    } catch (err) {
      this.deps.log.warn(`update: asking systemd about the update unit: ${errorText(err)}`);
      return false;
    }
  }

  /** The update itself, after `start` has answered. Every failure ends in `fail`. */
  private async perform(version: string): Promise<void> {
    const from = this.deps.currentVersion;
    const download = path.join(this.updateDir, version);
    const folder = `threadgarden-headless-${version}`;
    const tarName = `${folder}-linux-x64.tar.gz`;
    const tarball = path.join(download, tarName);
    const url = `${RELEASES}/v${version}/${tarName}`;
    let reason: UpdateFailure = 'download';
    try {
      // A service that dies from here on would come back showing it as this update's end.
      await rm(this.file('last.json'), { force: true });
      await rm(download, { recursive: true, force: true });
      await mkdir(download, { recursive: true });
      const actual = await this.downloadTo(url, tarball);
      const sums = await (await fetchChecked(`${url}.sha256`, this.deps)).text();

      reason = 'checksum';
      const expected = /^([0-9a-f]{64})(\s|$)/i.exec(sums)?.[1]?.toLowerCase();
      if (expected === undefined) throw new Error('The checksum file has no sha256 in it');
      if (expected !== actual) {
        throw new Error(`The download's checksum didn't match (${actual}, not ${expected})`);
      }

      reason = 'unpack';
      this.stage(version, 'installing');
      const unpacked = await this.run('tar', ['-xzf', tarball, '-C', download]);
      if (unpacked.code !== 0) throw new Error(`tar failed: ${unpacked.stderr}`);
      const found = (await readFile(path.join(download, folder, 'VERSION'), 'utf8')).trim();
      if (found !== version) throw new Error(`The release says it is ${found}, not ${version}`);

      reason = 'install';
      await this.launch(version, from, path.join(download, folder, 'install.sh'));
      this.stage(version, 'restarting');
    } catch (err) {
      await this.fail(version, reason, errorText(err));
    }
  }

  /** Streams to `to` and answers its sha256: a release is too big to hold in memory. */
  private async downloadTo(url: string, to: string): Promise<string> {
    const res = await fetchChecked(url, this.deps, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!res.body) throw new Error('GitHub answered without a body');
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(to),
    );
    return hash.digest('hex');
  }

  private async launch(version: string, from: string, installSh: string): Promise<void> {
    await this.writeFileAtomic('apply.sh', APPLY_SCRIPT);
    // A `done` from an earlier update would pass for this one, and old skipped
    // steps would show a false note.
    await rm(this.file('last.json'), { force: true });
    await rm(this.file('skipped'), { force: true });
    await this.writeFileAtomic('pending.json', JSON.stringify({ version, from }));
    const launched = await this.run('systemd-run', [
      '--user',
      '--collect',
      `--unit=${unitName(version)}`,
      '/bin/sh',
      this.file('apply.sh'),
      ...applyArgs({
        installSh,
        version,
        from,
        installBase: this.installBase,
        updateDir: this.updateDir,
      }),
    ]);
    if (launched.code !== 0) throw new Error(`systemd-run failed: ${launched.stderr}`);
  }

  /** Nothing has touched the running version, so it simply carries on. */
  private async fail(version: string, reason: UpdateFailure, detail: string): Promise<void> {
    this.deps.log.error(`update to ${version} failed (${reason}): ${detail}`);
    const failed: UpdateStatus = {
      state: 'failed',
      version,
      from: this.deps.currentVersion,
      reason,
      detail: shortDetail(detail),
    };
    try {
      await rm(path.join(this.updateDir, version), { recursive: true, force: true });
      await rm(this.file('pending.json'), { force: true });
      await this.writeFileAtomic('last.json', JSON.stringify(failed));
    } catch (err) {
      this.deps.log.error(`update: cleaning up after a failure: ${errorText(err)}`);
    }
    this.memory = failed;
    this.tell(failed);
  }

  private stage(version: string, stage: UpdateStage): void {
    const running: UpdateStatus = {
      state: 'running',
      version,
      from: this.deps.currentVersion,
      stage,
    };
    this.memory = running;
    this.tell(running);
  }

  /** Nobody listening must never cost the update. */
  private tell(s: UpdateStatus): void {
    try {
      this.deps.emit(s);
    } catch (err) {
      this.deps.log.warn(`update: telling clients: ${errorText(err)}`);
    }
  }

  private file(name: string): string {
    return path.join(this.updateDir, name);
  }

  /** Replaced in one step: the apply script and a restarted service must never see half a file. */
  private async writeFileAtomic(name: string, text: string): Promise<void> {
    await mkdir(this.updateDir, { recursive: true });
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private readLast(): UpdateStatus | undefined {
    return this.readJson('last.json', LastSchema);
  }

  private readPending(): Pending | undefined {
    return this.readJson('pending.json', PendingSchema);
  }

  /** A file that is missing, or that can't be used: a service must start whatever it finds. */
  private readJson<T>(name: string, schema: z.ZodType<T>): T | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file(name), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warnOnce(name, errorText(err));
      }
      return undefined;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    this.warnOnce(name, 'not what this version expects');
    return undefined;
  }

  private warnOnce(name: string, why: string): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    this.deps.log.warn(`update: ignoring ${name}: ${why}`);
  }

  private async readSkipped(): Promise<SkippedStep[]> {
    let text: string;
    try {
      text = await readFile(this.file('skipped'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const steps = new Set<SkippedStep>();
    for (const line of text.split('\n').map((l) => l.trim())) {
      if (line === '') continue;
      const step = SkippedStepSchema.safeParse(line);
      if (step.success) steps.add(step.data);
      else this.deps.log.warn(`update: a skipped step nobody knows: ${line}`);
    }
    return [...steps];
  }

  /**
   * Every folder here is a download, of this update or of one that never got to
   * clean up. Files stay: `sh` is still reading `apply.sh`.
   */
  private async removeDownloads(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.updateDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await rm(this.file(entry.name), { recursive: true, force: true });
      }
    }
  }
}

/** What the service needs of an updater; the mock service passes its own. */
export type Updater = Pick<MachineUpdater, 'supported' | 'status' | 'start' | 'reconcile'>;
