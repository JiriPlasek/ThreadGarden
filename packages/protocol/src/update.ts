import { z } from 'zod';

/** Advertised in `hello` by a headless service that can update itself (protocol 10). */
export const UPDATE_CAPABILITY = 'update';

export const UPDATE_ERRORS = {
  /** The machine cannot update itself (not a Linux install made by the installer). */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** An update is already running. */
  UPDATE_RUNNING: 'UPDATE_RUNNING',
  /** The machine already runs that version (and `force` was not set). */
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
