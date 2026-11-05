import { z } from 'zod';
import { ChatSummarySchema, ProjectSchema } from './chat.js';
import { ChatItemSchema } from './items.js';
import { MachineInfoSchema } from './machines.js';

/** Advertised by a service that takes `messageId` on `chat.send` and `sessionId` on `chat.create` (protocol 11). */
export const AWAY_CAPABILITY = 'away';

/** Error code of a chat call for a machine that is off or away (`‹machine› is off`). */
export const AWAY_ERROR = 'AWAY';

/**
 * The chat items a copy keeps: what was said, and what was asked of the user.
 * The options come out of `ChatItemSchema` by position (user, assistantText,
 * permissionRequest), so a change to an item shape is followed here; the
 * `away` test pins which kinds they are.
 *
 * Text only: a user message keeps how many images it had (`imageCount`), never
 * their data, which parsing drops.
 */
const [userItem, assistantItem, , , , permissionItem] = ChatItemSchema.options;
const copiedUserItem = userItem
  .omit({ images: true })
  .extend({ imageCount: z.number().int().nonnegative().optional() });
export const CopyItemSchema = z.discriminatedUnion('kind', [
  copiedUserItem,
  assistantItem,
  permissionItem,
]);
export type CopyItem = z.infer<typeof CopyItemSchema>;

/** What the desktop kept of a machine's lists, for when the machine is off. */
export const MachineCopySchema = z.object({
  machineId: z.string(),
  info: MachineInfoSchema.nullable(),
  projects: z.array(ProjectSchema),
  chats: z.array(ChatSummarySchema),
  copiedAt: z.number(),
});
export type MachineCopy = z.infer<typeof MachineCopySchema>;

/** What the desktop kept of one chat. */
export const ChatCopySchema = z.object({
  machineId: z.string(),
  sessionId: z.string(),
  summary: ChatSummarySchema,
  items: z.array(CopyItemSchema),
  copiedAt: z.number(),
});
export type ChatCopy = z.infer<typeof ChatCopySchema>;

/**
 * A message written while the machine is away. `waiting` for the machine,
 * `sending` while it goes out, `failed` with `reason`: `start` (the machine
 * would not start) or `refused` (it answered with an error, in `error`).
 */
export const AwayItemSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  sessionId: z.string(),
  kind: z.enum(['send', 'create']),
  text: z.string(),
  imageCount: z.number().int(),
  /** The folder of a new chat (`create`); null for a `send`. */
  cwd: z.string().nullable(),
  createdAt: z.number(),
  state: z.enum(['waiting', 'sending', 'failed']),
  reason: z.enum(['start', 'refused']).nullable(),
  error: z.string().nullable(),
});
export type AwayItem = z.infer<typeof AwayItemSchema>;

/** Whether the desktop is starting a machine for its waiting messages, and since when. */
export const AwayStateSchema = z.object({
  machineId: z.string(),
  starting: z.boolean(),
  startedAt: z.number().nullable(),
});
export type AwayState = z.infer<typeof AwayStateSchema>;
