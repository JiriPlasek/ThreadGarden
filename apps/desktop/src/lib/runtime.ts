/**
 * Which runtime a chat or a model belongs to. The service routes on two
 * prefixes: Codex chats have `codex-` session ids, and Codex models are
 * offered as `codex:<model>` picker values. Everything else is Claude.
 */
export type Runtime = 'claude' | 'codex';

/** A Codex chat, known by its session id. */
export const isCodexChat = (sessionId: string): boolean => sessionId.startsWith('codex-');

/** A Codex model picker value. */
export const isCodexModel = (model: string | null | undefined): boolean =>
  model?.startsWith('codex:') ?? false;

/** The runtime a session id belongs to. */
export const runtimeOfChat = (sessionId: string): Runtime =>
  isCodexChat(sessionId) ? 'codex' : 'claude';

/** The runtime a picker value belongs to; an empty value (Default) is Claude's. */
export const runtimeOfModel = (model: string | null | undefined): Runtime =>
  isCodexModel(model) ? 'codex' : 'claude';

/** The agent's name in copy ("What should Codex do?"). */
export const agentNameOf = (runtime: Runtime): 'Codex' | 'Claude' =>
  runtime === 'codex' ? 'Codex' : 'Claude';

/**
 * Picker values split by runtime, in their given order. A picker shows the
 * two as groups only when both have models; otherwise it stays one list.
 */
export const modelsByRuntime = <T extends { value: string }>(
  models: readonly T[],
): { claude: T[]; codex: T[] } => ({
  claude: models.filter((m) => !isCodexModel(m.value)),
  codex: models.filter((m) => isCodexModel(m.value)),
});
