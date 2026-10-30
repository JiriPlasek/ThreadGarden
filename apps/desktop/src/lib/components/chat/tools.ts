import { computeDiff, type Diff } from './diff';
import type { ToolCallItem } from './rows';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One-line JSON, cut at `max` characters. */
export const compactJson = (v: unknown, max = 200): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Indented JSON for the raw views (never throws: cycles and BigInts degrade to text). */
export const prettyJson = (v: unknown): string => {
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2) ??
      String(v)
    );
  } catch {
    return String(v);
  }
};

const firstLine = (s: string): string => {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length < s.length ? `${line} …` : line;
};

const nonEmptyLines = (s: string | undefined): number =>
  s ? s.split('\n').filter((l) => l.trim() !== '').length : 0;

/** "N things" from a Grep/Glob result ("Found 3 files", "No files found", or one per line). */
const resultCount = (item: ToolCallItem, noun: string): string | undefined => {
  if (item.status !== 'ok' || item.resultText === undefined) return undefined;
  const t = item.resultText.trim();
  const found = /^Found (\d+) (\w+)/.exec(t);
  if (found) return `${found[1]} ${found[2]}`;
  if (/^No (files|matches) found/i.test(t)) return `0 ${noun}s`;
  const n = nonEmptyLines(t);
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
};

export type EditPair = { oldText: string; newText: string };

/** The before/after pairs an editing tool call carries (Edit, MultiEdit, Write). */
export const editPairs = (item: ToolCallItem): EditPair[] | null => {
  const input = rec(item.input);
  if (item.name === 'Edit')
    return [{ oldText: str(input.old_string), newText: str(input.new_string) }];
  if (item.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => ({
      oldText: str(rec(e).old_string),
      newText: str(rec(e).new_string),
    }));
  }
  if (item.name === 'Write') return [{ oldText: '', newText: str(input.content) }];
  return null;
};

export type EditDiff = EditPair & { diff: Diff };

const DIFF_CACHE_SIZE = 200;
/** Last computed diffs per item id; reused while the item's edit text is unchanged. */
const diffCache = new Map<string, EditDiff[]>();

const samePairs = (a: readonly EditPair[], b: readonly EditPair[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => p.oldText === b[i]!.oldText && p.newText === b[i]!.newText);

/**
 * The diffs of an editing tool call, computed once per item id and content
 * (the collapsed row's stats and the expanded DiffView share them).
 */
export const editDiffs = (item: ToolCallItem): EditDiff[] | null => {
  const pairs = editPairs(item);
  if (!pairs) return null;
  const key = `${item.name}:${item.id}`;
  const hit = diffCache.get(key);
  if (hit && samePairs(hit, pairs)) return hit;
  const diffs = pairs.map((p) => ({ ...p, diff: computeDiff(p.oldText, p.newText) }));
  diffCache.delete(key);
  diffCache.set(key, diffs);
  if (diffCache.size > DIFF_CACHE_SIZE) diffCache.delete(diffCache.keys().next().value as string);
  return diffs;
};

export type ToolSummary = {
  /** The tool name as shown. */
  verb: string;
  /** What it acted on: a path, command, pattern, URL, description… */
  target: string;
  /** Short trailing facts (count, exit status, diff stats). */
  detail?: string;
  /** Diff stats for editing tools. */
  stats?: { added: number; removed: number };
};

const exitStatus = (item: ToolCallItem, input: Rec): string | undefined => {
  if (item.status === 'running') return undefined;
  if (item.status === 'error') {
    const code = /exit code (\d+)/i.exec(item.resultText ?? '');
    return code ? `exit ${code[1]}` : 'error';
  }
  return input.run_in_background === true ? 'in background' : 'exit 0';
};

/**
 * The collapsed one-liner for a tool call (spec §6.4: "Bash · npm test · exit 0").
 * `stats: false` skips diffing edits (previews that only need the target).
 */
export const summarize = (item: ToolCallItem, opts: { stats?: boolean } = {}): ToolSummary => {
  const input = rec(item.input);
  switch (item.name) {
    case 'Read': {
      const range =
        typeof input.offset === 'number' || typeof input.limit === 'number'
          ? `from line ${Number(input.offset ?? 1)}`
          : undefined;
      return { verb: 'Read', target: str(input.file_path) || str(input.path), detail: range };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const target = str(input.file_path);
      if (opts.stats === false) return { verb: item.name, target };
      let added = 0;
      let removed = 0;
      for (const { diff } of editDiffs(item) ?? []) {
        added += diff.added;
        removed += diff.removed;
      }
      return { verb: item.name, target, stats: { added, removed } };
    }
    case 'NotebookEdit':
      return { verb: 'NotebookEdit', target: str(input.notebook_path) };
    case 'Bash':
      return {
        verb: 'Bash',
        target: firstLine(str(input.command)),
        detail: exitStatus(item, input),
      };
    case 'Grep': {
      const where = str(input.glob) || str(input.path);
      const count = resultCount(item, 'match');
      return {
        verb: 'Grep',
        target: str(input.pattern),
        detail: [where && `in ${where}`, count].filter(Boolean).join(' · ') || undefined,
      };
    }
    case 'Glob':
      return { verb: 'Glob', target: str(input.pattern), detail: resultCount(item, 'file') };
    case 'WebFetch':
      return { verb: 'WebFetch', target: str(input.url) };
    case 'WebSearch':
      return { verb: 'WebSearch', target: str(input.query) };
    case 'Agent':
    case 'Task':
      return {
        verb: item.name,
        target: str(input.description) || firstLine(str(input.prompt)),
        detail: str(input.subagent_type) || undefined,
      };
    case 'TodoWrite':
      return {
        verb: 'TodoWrite',
        target: Array.isArray(input.todos)
          ? `${input.todos.length} todos`
          : compactJson(item.input),
      };
    default:
      return { verb: item.name, target: compactJson(item.input) };
  }
};

/** Plural label for a run of same-tool calls ("Read 12 files"). */
export const groupLabel = (name: string, count: number): string => {
  const noun: Record<string, [string, string]> = {
    Read: ['file', 'files'],
    Grep: ['search', 'searches'],
    Glob: ['pattern', 'patterns'],
    LS: ['folder', 'folders'],
    WebFetch: ['page', 'pages'],
    WebSearch: ['search', 'searches'],
  };
  const [one, many] = noun[name] ?? ['call', 'calls'];
  return `${name} ${count} ${count === 1 ? one : many}`;
};
