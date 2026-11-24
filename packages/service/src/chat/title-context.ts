/** Naming uses the visible main conversation, never tool output or agent transcripts. */
import type { ChatItem } from '@threadgarden/protocol';
import type { TitleMessage } from './titles.js';

const CONTROL = /^\/(compact|model|effort|permissions|clear|help|resume)(?:\s|$)/i;

export const titleMessages = (items: readonly ChatItem[]): TitleMessage[] =>
  items.flatMap((item): TitleMessage[] => {
    if ('parentToolUseId' in item && item.parentToolUseId) return [];
    if (item.kind === 'user') {
      const text = item.text.trim();
      if (!text || text.startsWith('[Threadgarden] ') || CONTROL.test(text)) return [];
      return [{ id: item.id, role: 'user', text }];
    }
    if (item.kind === 'assistantText' && !item.streaming && item.markdown.trim())
      return [{ id: item.id, role: 'assistant', text: item.markdown.trim() }];
    return [];
  });
