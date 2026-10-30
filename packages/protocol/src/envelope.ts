import { z } from 'zod';

export const RequestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.unknown(),
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.union([
  z.object({ id: z.number(), result: z.unknown() }),
  z.object({ id: z.number(), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type Response = z.infer<typeof ResponseSchema>;

export const EventMsgSchema = z.object({ event: z.string(), data: z.unknown() });
export type EventMsg = z.infer<typeof EventMsgSchema>;

/**
 * Largest request frame the service accepts, in bytes. It fits a message with
 * the most images the composer attaches (20 MiB in all, ~27 MiB as base64)
 * plus its text; the client refuses anything larger with a clear error rather
 * than sending a frame the service would close the connection on.
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
