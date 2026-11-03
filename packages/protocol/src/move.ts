import { z } from 'zod';

/** Advertised in `hello` by a service that can export and import a chat (protocol 9). */
export const MOVE_CAPABILITY = 'move';

export const MOVE_ERRORS = {
  /** The chat is being moved: `chat.send` is refused until the move ends. */
  moving: 'MOVING',
  /** The chat moved away for good. */
  moved: 'MOVED',
  busy: 'BUSY',
  notFound: 'NOT_FOUND',
  tooLarge: 'TOO_LARGE',
  /** The export or import is gone (its lock ran out or it was never begun). */
  expired: 'EXPIRED',
} as const;

/** One transcript entry as the SDK session store holds it: any JSON with a string `type`. */
export const MoveEntrySchema = z.object({ type: z.string() }).passthrough();
export type MoveEntry = z.infer<typeof MoveEntrySchema>;

/** The entries of one store key: the main transcript, or a `subpath` (e.g. a subagent's). */
export const MoveKeySchema = z.object({
  subpath: z.string().optional(),
  entries: z.array(MoveEntrySchema),
});
export type MoveKey = z.infer<typeof MoveKeySchema>;

/** What the chat's folder looks like in git; `origin` is the remote.origin URL. */
export const GitStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clean'),
    branch: z.string().nullable(),
    origin: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('dirty'),
    branch: z.string().nullable(),
    origin: z.string().nullable(),
    changed: z.number().int(),
    unpushed: z.number().int(),
  }),
  z.object({ kind: z.literal('notRepo') }),
]);
export type GitState = z.infer<typeof GitStateSchema>;

export const MoveBusySchema = z.enum(['turn', 'prompt', 'subagents']);
export type MoveBusy = z.infer<typeof MoveBusySchema>;

/** A machine as the moved chat names it. */
export const MovePeerSchema = z.object({ machineId: z.string(), name: z.string() });
export type MovePeer = z.infer<typeof MovePeerSchema>;
