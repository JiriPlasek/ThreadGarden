import type { ChatItem } from '@threadgarden/protocol';

export type ToolCallItem = Extract<ChatItem, { kind: 'toolCall' }>;
export type UnknownChatItem = Extract<ChatItem, { kind: 'unknown' }>;

/**
 * One row of the message list. Items started by a subagent ride along as
 * `children` of the Agent/Task call that started it; runs of unrecognised items
 * (R12) and of same-tool lookups ("Read 12 files") collapse into one row each.
 * `itemIds` lists every top-level item the row stands for (scroll anchoring).
 */
export type Row =
  | { kind: 'item'; key: string; item: ChatItem; children?: ChatItem[]; itemIds: string[] }
  | { kind: 'unknownGroup'; key: string; items: UnknownChatItem[]; itemIds: string[] }
  | { kind: 'toolGroup'; key: string; name: string; items: ToolCallItem[]; itemIds: string[] };

/** Tools that spawn a subagent: their children are grouped under them. */
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Read-only lookups that read well as one row when repeated back to back. */
const GROUPABLE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);

const parentOf = (it: ChatItem): string | null | undefined =>
  'parentToolUseId' in it ? it.parentToolUseId : undefined;

/**
 * Subagent descendants by the `toolUseId` of the call that started them, in
 * order. A nested subagent's items appear under every ancestor call, so a group
 * built from one call's list can nest its own subagents again.
 */
export const childrenByParent = (items: readonly ChatItem[]): Map<string, ChatItem[]> => {
  /** Spawner toolUseId → the spawner's own parent (null at the top level). */
  const spawners = new Map<string, string | null>();
  for (const it of items) {
    if (it.kind === 'toolCall' && SUBAGENT_TOOLS.has(it.name)) {
      spawners.set(it.toolUseId, it.parentToolUseId ?? null);
    }
  }
  const out = new Map<string, ChatItem[]>();
  for (const it of items) {
    let p = parentOf(it);
    for (let depth = 0; p && spawners.has(p) && depth < 32; depth++) {
      const list = out.get(p);
      if (list) list.push(it);
      else out.set(p, [it]);
      p = spawners.get(p);
    }
  }
  return out;
};

/**
 * Groups `items` (in order) into rows. Items whose subagent call is not among
 * `items` (e.g. not paged in yet) stay at this level: nothing is ever dropped.
 */
export const buildRows = (items: readonly ChatItem[]): Row[] => {
  const children = childrenByParent(items);
  const nested = new Set<string>();
  for (const list of children.values()) for (const c of list) nested.add(c.id);

  const rows: Row[] = [];
  for (const it of items) {
    if (nested.has(it.id)) continue;
    const prev = rows.at(-1);
    if (it.kind === 'unknown') {
      if (prev?.kind === 'unknownGroup') {
        prev.items.push(it);
        prev.itemIds.push(it.id);
        continue;
      }
      if (prev?.kind === 'item' && prev.item.kind === 'unknown') {
        rows[rows.length - 1] = {
          kind: 'unknownGroup',
          key: `unknown:${prev.item.id}`,
          items: [prev.item, it],
          itemIds: [prev.item.id, it.id],
        };
        continue;
      }
    }
    if (it.kind === 'toolCall' && GROUPABLE_TOOLS.has(it.name)) {
      if (prev?.kind === 'toolGroup' && prev.name === it.name) {
        prev.items.push(it);
        prev.itemIds.push(it.id);
        continue;
      }
      if (prev?.kind === 'item' && prev.item.kind === 'toolCall' && prev.item.name === it.name) {
        rows[rows.length - 1] = {
          kind: 'toolGroup',
          key: `group:${prev.item.id}`,
          name: it.name,
          items: [prev.item, it],
          itemIds: [prev.item.id, it.id],
        };
        continue;
      }
    }
    const kids = it.kind === 'toolCall' ? children.get(it.toolUseId) : undefined;
    rows.push(
      kids
        ? { kind: 'item', key: it.id, item: it, children: kids, itemIds: [it.id] }
        : { kind: 'item', key: it.id, item: it, itemIds: [it.id] },
    );
  }
  return rows;
};
