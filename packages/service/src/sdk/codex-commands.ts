/** Commands executed by the app-server, rather than sent to the model as text. */
import type { SDKUserMessage, SlashCommand } from './adapter.js';

export const CODEX_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compact the conversation context', argumentHint: '' },
];

/** A slash token is a command; an absolute path such as /home/me/file.ts is ordinary text. */
export const codexCommand = (message: SDKUserMessage): string | undefined => {
  const content = message.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content[0]?.type === 'text'
        ? content[0].text
        : '';
  return /^\/([a-z][\w-]*)(?=\s|$)/i.exec(text.trim())?.[1];
};

export const isBareCompact = (message: SDKUserMessage): boolean => {
  const content = message.message.content;
  if (typeof content === 'string') return content.trim() === '/compact';
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    content[0].text.trim() === '/compact'
  );
};
