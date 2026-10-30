import { structuredPatch } from 'diff';

export type DiffRow =
  | { type: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string }
  | { type: 'hunk'; text: string };

export type SplitRow =
  | { type: 'hunk'; text: string }
  | {
      type: 'pair';
      left?: { no: number; text: string; type: 'ctx' | 'del' };
      right?: { no: number; text: string; type: 'ctx' | 'add' };
    };

export type Diff = { rows: DiffRow[]; added: number; removed: number; exact: boolean };

/** Inputs bigger than this are not diffed line by line (all old lines removed, all new added). */
const MAX_DIFF_CHARS = 1_000_000;
const DIFF_TIMEOUT_MS = 150;

const lines = (s: string): string[] => {
  if (s === '') return [];
  const out = s.split(/\r?\n/);
  if (out.at(-1) === '') out.pop();
  return out;
};

/** Everything removed, then everything added: the fallback when a real diff is too costly. */
const wholesale = (oldText: string, newText: string): Diff => {
  const del = lines(oldText).map((text, i): DiffRow => ({ type: 'del', oldNo: i + 1, text }));
  const add = lines(newText).map((text, i): DiffRow => ({ type: 'add', newNo: i + 1, text }));
  return { rows: [...del, ...add], added: add.length, removed: del.length, exact: false };
};

/** A unified diff (3 lines of context) as display rows, with line numbers of each side. */
export const computeDiff = (oldText: string, newText: string): Diff => {
  if (oldText === '' || oldText.length + newText.length > MAX_DIFF_CHARS) {
    const d = wholesale(oldText, newText);
    return { ...d, exact: oldText === '' };
  }
  const patch = structuredPatch('a', 'b', oldText, newText, undefined, undefined, {
    context: 3,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!patch) return wholesale(oldText, newText);
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  for (const h of patch.hunks) {
    rows.push({
      type: 'hunk',
      text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const mark = l[0];
      const text = l.slice(1);
      if (mark === '+') {
        rows.push({ type: 'add', newNo: n++, text });
        added++;
      } else if (mark === '-') {
        rows.push({ type: 'del', oldNo: o++, text });
        removed++;
      } else if (mark === ' ') {
        rows.push({ type: 'ctx', oldNo: o++, newNo: n++, text });
      }
      // '\ No newline at end of file' markers are not shown.
    }
  }
  return { rows, added, removed, exact: true };
};

/** Side-by-side rows: runs of removed lines are paired with the added lines that follow. */
export const toSplit = (rows: readonly DiffRow[]): SplitRow[] => {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.type === 'hunk') {
      out.push(r);
      i++;
    } else if (r.type === 'ctx') {
      out.push({
        type: 'pair',
        left: { no: r.oldNo!, text: r.text, type: 'ctx' },
        right: { no: r.newNo!, text: r.text, type: 'ctx' },
      });
      i++;
    } else {
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (rows[i]?.type === 'del') dels.push(rows[i++]!);
      while (rows[i]?.type === 'add') adds.push(rows[i++]!);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        out.push({
          type: 'pair',
          left: d && d.type === 'del' ? { no: d.oldNo!, text: d.text, type: 'del' } : undefined,
          right: a && a.type === 'add' ? { no: a.newNo!, text: a.text, type: 'add' } : undefined,
        });
      }
    }
  }
  return out;
};
