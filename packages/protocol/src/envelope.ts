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
