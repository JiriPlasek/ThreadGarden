import { parseChatKey } from '#lib/state/refs.js';
import type { Scopes } from '#lib/state/scope.js';

/** A chat's title by its key, from what its machine's stores know ('Loading…' until then). */
export const chatTitle = (scopes: Pick<Scopes, 'get'>, key: string): string => {
  const ref = parseChatKey(key);
  const scope = ref ? scopes.get(ref.machineId) : undefined;
  if (!ref || !scope) return 'Loading…';
  return (
    scope.sessions.items.find((c) => c.sessionId === ref.sessionId)?.title ??
    scope.chats.get(ref.sessionId)?.summary?.title ??
    scope.chats.summaryOf(ref.sessionId)?.title ??
    'Loading…'
  );
};
