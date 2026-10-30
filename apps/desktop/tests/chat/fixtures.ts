import type { ChatItem } from '@pahub/protocol';

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

export const user = (id: string, text = `question ${id}`, over: Partial<Of<'user'>> = {}) =>
  ({ kind: 'user', id, text, ts: 1_700_000_000_000, ...over }) satisfies Of<'user'>;

export const text = (
  id: string,
  markdown = `answer ${id}`,
  over: Partial<Of<'assistantText'>> = {},
) =>
  ({
    kind: 'assistantText',
    id,
    markdown,
    streaming: false,
    ...over,
  }) satisfies Of<'assistantText'>;

export const tool = (
  id: string,
  name: string,
  input: unknown,
  over: Partial<Of<'toolCall'>> = {},
): Of<'toolCall'> => ({
  kind: 'toolCall',
  id,
  toolUseId: `tu-${id}`,
  name,
  input,
  status: 'ok',
  parentToolUseId: null,
  ...over,
});

export const unknownItem = (
  id: string,
  sdkType = 'future_thing',
  raw: unknown = { type: sdkType },
) => ({ kind: 'unknown', id, sdkType, raw }) satisfies Of<'unknown'>;

/** A long chat alternating user questions, answers and tool calls. */
export const manyItems = (n: number): ChatItem[] =>
  Array.from({ length: n }, (_, i): ChatItem => {
    if (i % 3 === 0) return user(`i${i}`, `question number ${i}`);
    if (i % 3 === 1) return text(`i${i}`, `answer number **${i}**`);
    return tool(`i${i}`, 'Bash', { command: `echo ${i}` });
  });
