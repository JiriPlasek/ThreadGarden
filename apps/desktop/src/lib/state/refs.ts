/**
 * A chat is known by its machine and its session id: the same session id can
 * exist on two machines (a copied `~/.claude`), and they must stay apart in
 * tabs, lists and notifications.
 */
export type ChatRef = { machineId: string; sessionId: string };

/**
 * This PC's machine id when its service does not say (a service before
 * protocol 5 sends no `machine` in `hello`).
 */
export const LOCAL_FALLBACK_ID = 'local';

/** The id of the machine a `hello` answer came from (This PC's, for the local client). */
export const machineIdOf = (hello: { machine?: { id: string } | null } | null): string =>
  hello?.machine?.id ?? LOCAL_FALLBACK_ID;

/** `machineId/sessionId`: a tab's key, also what the stored layout keeps. */
export const chatKey = (ref: ChatRef): string => `${ref.machineId}/${ref.sessionId}`;

/** The reverse of `chatKey`; null for anything that is not one (e.g. a bare session id). */
export const parseChatKey = (key: string): ChatRef | null => {
  const i = key.indexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { machineId: key.slice(0, i), sessionId: key.slice(i + 1) };
};
