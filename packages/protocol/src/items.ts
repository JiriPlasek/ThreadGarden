import { z } from 'zod';

export const ImageRefSchema = z.object({
  mediaType: z.string(),
  data: z.string(),
  /** The number of its `[Image #N]` tag in the message text, when known. */
  number: z.number().int().positive().optional(),
});
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
 * A message Claude never read, given back to the user whole: one taken back
 * from the queue (`chat.withdraw`), or one the queue gave back
 * (`messagesReturned`).
 */
export const ReturnedMessageSchema = z.object({
  text: z.string(),
  images: z.array(ImageRefSchema).optional(),
});
export type ReturnedMessage = z.infer<typeof ReturnedMessageSchema>;

/**
 * A chat's draft with messages Claude never read put back in front of it,
 * oldest first, one per line, as the terminal puts queued messages back into
 * its input. The service and the composer both merge this way.
 */
export const withReturned = (draft: string, texts: readonly string[]): string =>
  [...texts, draft].filter((t) => t.length > 0).join('\n');

const IMAGE_TAG = /\[Image #([1-9]\d*)\]/g;

/**
 * `withReturned` for a draft with images: each given-back message's images,
 * and the `[Image #N]` tags in its text that stand for them, get numbers past
 * every tag and image already there, so no two tags in the draft meet. The
 * service (the saved draft) and the desktop (a draft no composer shows) both
 * merge this way.
 */
export const draftWithReturned = (
  draft: { text: string; images: readonly ImageRef[] },
  messages: readonly ReturnedMessage[],
): { text: string; images: ImageRef[] } => {
  const taken = [draft.text, ...messages.map((m) => m.text)].flatMap((t) =>
    [...t.matchAll(IMAGE_TAG)].map((m) => Number(m[1])),
  );
  let next = Math.max(0, ...taken, ...draft.images.map((i) => i.number ?? 0)) + 1;
  const texts: string[] = [];
  const images: ImageRef[] = [];
  for (const message of messages) {
    const fresh = new Map<number, number>();
    for (const image of message.images ?? []) {
      if (image.number === undefined) {
        images.push(image);
        continue;
      }
      if (!fresh.has(image.number)) fresh.set(image.number, next++);
      images.push({ ...image, number: fresh.get(image.number)! });
    }
    texts.push(
      message.text.replace(IMAGE_TAG, (tag, n: string) => {
        const number = fresh.get(Number(n));
        return number === undefined ? tag : `[Image #${number}]`;
      }),
    );
  }
  return { text: withReturned(draft.text, texts), images: [...images, ...draft.images] };
};

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
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    /** SDK subagent identity, when the completed Agent call reports one. */
    agentId: z.string().optional(),
    /** Reported token total for an Agent/Task call, when available. */
    tokens: z.number().finite().nonnegative().optional(),
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
     * R27: notifications and hand-backs the CLI injects as user turns; a
     * loaded skill's instructions).
     */
    detail: z.string().optional(),
    /**
     * When a background task's notification came (epoch ms): live, its
     * arrival; in history, its timestamp. Absent on other system items.
     */
    ts: z.number().optional(),
    ...parent,
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
