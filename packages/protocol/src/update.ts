import { z } from 'zod';

/**
 * Frozen: only optional additions, here and in `update.start` and `update.status`.
 * A machine left behind must still update from any later desktop to any later
 * release, and its old updater and old `apply.sh` run against every future release.
 * So these, outside this file, must stay too:
 * - the release: `latest.json`'s `version`; `releases/download/v<version>/`
 *   `threadgarden-headless-<version>-linux-x64.tar.gz` and its `.sha256`; it unpacks
 *   to the folder `threadgarden-headless-<version>/` with `VERSION` and `install.sh`
 *   at its root, and `threadgarden.service` in it;
 * - `install.sh` honours the environment's `SUDO` and `THREADGARDEN_SKIPPED_FILE`;
 * - `last.json`'s keys, those of `UpdateStatus`: `apply.sh` reads `state` and
 *   `version` from what the new version writes, and an old service reads what `apply.sh` writes;
 * - `hello`'s `serviceVersion`, `protocolVersion`, `machine.id` and `machine.capabilities`.
 */

/** Advertised in `hello` by a headless service that can update itself (protocol 10). */
export const UPDATE_CAPABILITY = 'update';

export const UPDATE_ERRORS = {
  /** The machine cannot update itself (not an x64 Linux install made by the installer). */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** An update is already running. */
  UPDATE_RUNNING: 'UPDATE_RUNNING',
  /** The machine already runs that version; `force` makes no difference. */
  ALREADY_CURRENT: 'ALREADY_CURRENT',
  INVALID_VERSION: 'INVALID_VERSION',
  /** The release could not be looked up (no network, or GitHub did not answer). */
  UNREACHABLE: 'UNREACHABLE',
} as const;

/**
 * A release version as it is put in a download URL: no slash, no leading dot,
 * so it can never leave the release path.
 */
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

export const UpdateStageSchema = z.enum(['downloading', 'installing', 'restarting']);
export type UpdateStage = z.infer<typeof UpdateStageSchema>;

/** A step the update left out because the machine does not allow it; the update still succeeded. */
export const SkippedStepSchema = z.enum(['linger', 'polkit']);
export type SkippedStep = z.infer<typeof SkippedStepSchema>;

export const UpdateFailureSchema = z.enum(['download', 'checksum', 'unpack', 'install', 'start']);
export type UpdateFailure = z.infer<typeof UpdateFailureSchema>;

export const UpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({
    state: z.literal('running'),
    version: z.string(),
    from: z.string(),
    stage: UpdateStageSchema,
  }),
  z.object({
    state: z.literal('done'),
    version: z.string(),
    from: z.string(),
    skipped: z.array(SkippedStepSchema),
  }),
  z.object({
    state: z.literal('failed'),
    version: z.string(),
    from: z.string(),
    reason: UpdateFailureSchema,
    detail: z.string().optional(),
  }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** `busy`: how many chats are running and would be stopped; the update starts only with `force`. */
export const UpdateStartResultSchema = z.union([
  z.object({ started: z.literal(true) }),
  z.object({ started: z.literal(false), busy: z.number().int() }),
]);
export type UpdateStartResult = z.infer<typeof UpdateStartResultSchema>;
