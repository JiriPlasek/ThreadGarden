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

/** Picker values split by runtime, in their given order. */
export const modelsByRuntime = <T extends { value: string }>(
  models: readonly T[],
): { claude: T[]; codex: T[] } => ({
  claude: models.filter((m) => !isCodexModel(m.value)),
  codex: models.filter((m) => isCodexModel(m.value)),
});

/** Claude Code's own "use the default" row: an older service's, or a newer one's that matched no model. */
export const LEGACY_DEFAULT = 'default';

type Row = { value: string; isDefault?: boolean | undefined };

/**
 * One runtime's rows as a picker lists them. A service that marks its default
 * (`isDefault`) folds Claude's `default` row into the model it resolves to, so
 * an unmarked `default` row beside a marked one is dropped. A `default` row that
 * is itself marked (no model matched it), or an older service's, is kept: it
 * stands for the default.
 */
export const pickerRows = <T extends Row>(rows: readonly T[]): T[] =>
  rows.some((m) => m.isDefault)
    ? rows.filter((m) => m.value !== LEGACY_DEFAULT || m.isDefault)
    : [...rows];

/** The row a picker preselects: the marked default, else an older service's `default` row, else the first. */
export const defaultRow = <T extends Row>(rows: readonly T[]): T | undefined =>
  rows.find((m) => m.isDefault) ?? rows.find((m) => m.value === LEGACY_DEFAULT) ?? rows[0];

/**
 * The model a new chat asks for: the picked row's value. An older service's
 * `default` row means "no model named", which is how it always started one.
 */
export const requestedModel = (value: string): string => (value === LEGACY_DEFAULT ? '' : value);
