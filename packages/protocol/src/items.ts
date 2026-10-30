import { z } from 'zod';

export const ImageRefSchema = z.object({ mediaType: z.string(), data: z.string() });
export type ImageRef = z.infer<typeof ImageRefSchema>;

export const ChatItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string(),
    text: z.string(),
    images: z.array(ImageRefSchema).optional(),
    ts: z.number(),
  }),
  z.object({
    kind: z.literal('assistantText'),
    id: z.string(),
    markdown: z.string(),
    streaming: z.boolean(),
  }),
  z.object({ kind: z.literal('thinking'), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('toolCall'),
    id: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: z.enum(['running', 'ok', 'error']),
    resultText: z.string().optional(),
    resultTruncated: z.boolean().optional(),
    parentToolUseId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('todo'),
    id: z.string(),
    todos: z.array(z.object({ content: z.string(), status: z.string() })),
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
  }),
  z.object({ kind: z.literal('compactBoundary'), id: z.string() }),
  z.object({
    kind: z.literal('result'),
    id: z.string(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    usage: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    id: z.string(),
    sdkType: z.string(),
    raw: z.unknown(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
