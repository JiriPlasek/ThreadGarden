/**
 * `node:sqlite` prints an ExperimentalWarning when first loaded. This module
 * must be imported before `node:sqlite`; it drops only that one warning and
 * forwards every other warning unchanged.
 */
const original = process.emitWarning.bind(process) as (...a: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const first = args[0];
  const type =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && 'type' in first
        ? String((first as { type: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : undefined;
  const text = warning instanceof Error ? warning.message : warning;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  original(warning, ...args);
}) as typeof process.emitWarning;

export {};
