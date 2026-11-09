import { z } from 'zod';

export const ImageRefSchema = z.object({ mediaType: z.string(), data: z.string() });
export type ImageRef = z.infer<typeof ImageRefSchema>;

/**
 * A message the user sent while Claude was working that Claude has not read
 * yet. Claude Code takes it up at the turn's next step (or when the turn
 * ends); until then it is shown apart from the transcript, and at that point
 * it becomes a `user` item with the same `id`, where Claude read it.
 */
export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /**
   * How many images it carries (absent: none). Not the images: the list goes
   * out with every status change; the `user` item carries them.
   */
  imageCount: z.number().int().positive().optional(),
  /** When it was sent (epoch ms). */
  ts: z.number(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/**
 * Set on items produced inside a subagent: the `tool_use` id of the Agent/Task
 * call that started it (SDK `parent_tool_use_id`). Absent on main-thread items.
 */
const parent = { parentToolUseId: z.string().optional() };

export const ChatItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string(),
    text: z.string(),
    images: z.array(ImageRefSchema).optional(),
    ts: z.number(),
    ...parent,
  }),
  z.object({
    kind: z.literal('assistantText'),
    id: z.string(),
    markdown: z.string(),
    streaming: z.boolean(),
    ...parent,
  }),
  z.object({ kind: z.literal('thinking'), id: z.string(), text: z.string(), ...parent }),
  z.object({
    kind: z.literal('toolCall'),
    id: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: z.enum(['running', 'ok', 'error']),
    /** Running, and waiting longer than usual (about 4 s) on its automatic permission check. */
    checkingPermission: z.literal(true).optional(),
    resultText: z.string().optional(),
    resultTruncated: z.boolean().optional(),
    parentToolUseId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('todo'),
    id: z.string(),
    todos: z.array(z.object({ content: z.string(), status: z.string() })),
    ...parent,
  }),
  z.object({
    kind: z.literal('permissionRequest'),
    id: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    title: z.string().optional(),
    decisionReason: z.string().optional(),
    suggestions: z.array(z.unknown()),
    state: z.enum(['pending', 'allowed', 'denied', 'cancelled']),
    variant: z.enum(['tool', 'question', 'plan']),
  }),
  z.object({
    kind: z.literal('system'),
    id: z.string(),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
    /** Set on a startup failure whose fix is installing or updating Claude Code (setup screen). */
    setup: z.boolean().optional(),
    /**
     * Full text behind a collapsed item whose `text` is a short label (Ruling
     * R27: notifications and hand-backs the CLI injects as user turns).
     */
    detail: z.string().optional(),
  }),
  z.object({ kind: z.literal('compactBoundary'), id: z.string() }),
  z.object({
    kind: z.literal('result'),
    id: z.string(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    usage: z.unknown().optional(),
    /** When the turn finished (epoch ms): the `result`'s arrival, or the turn's last reply in history. */
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    id: z.string(),
    sdkType: z.string(),
    raw: z.unknown(),
    ...parent,
  }),
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
