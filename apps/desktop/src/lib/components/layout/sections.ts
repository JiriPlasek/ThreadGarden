import { sidebarTime, type ChatSummary } from '@threadgarden/protocol';

/**
 * Recency sections of the chat list (v1.2 §2), by sidebar recency: the last
 * hour, the last 24 hours, and so on. "Now" is the one section of the Needs you and
 * Running places, whose chats are all of that kind.
 */
export type SectionId = 'now' | 'hour' | 'day' | 'week' | 'month' | 'older';

export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  now: 'Now',
  hour: 'Last hour',
  day: 'Last 24 hours',
  week: 'Last 7 days',
  month: 'Last 30 days',
  older: 'Older',
};

const ORDER: readonly SectionId[] = ['now', 'hour', 'day', 'week', 'month', 'older'];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * The recency section of a last-activity time. A boundary belongs to the newer
 * section (exactly 24 h old is "Last 24 hours"); clock skew reads as recent and
 * a missing time (0, NaN) as older.
 */
export const recencySection = (lastActivity: number, now: number): SectionId => {
  if (!Number.isFinite(lastActivity) || lastActivity <= 0) return 'older';
  const age = now - lastActivity;
  if (age <= HOUR_MS) return 'hour';
  if (age <= DAY_MS) return 'day';
  if (age <= 7 * DAY_MS) return 'week';
  if (age <= 30 * DAY_MS) return 'month';
  return 'older';
};

export type HeaderRow = {
  kind: 'header';
  key: string;
  section: SectionId;
  label: string;
  count: number;
  /** The last section while more pages are to come: its count can still grow. */
  more: boolean;
};

export type ChatRow<T extends ChatSummary = ChatSummary> = {
  kind: 'chat';
  key: string;
  chat: T;
  /** Position among the chats, in display order. */
  index: number;
  section: SectionId;
};

export type ListRow<T extends ChatSummary = ChatSummary> = HeaderRow | ChatRow<T>;

export type Grouped<T extends ChatSummary = ChatSummary> = {
  /** Headers and chats, as the virtual list shows them. */
  rows: ListRow<T>[];
  /** The chats in display order (what keyboard navigation walks). */
  chats: T[];
  /** `rowOf[i]`: the row index of `chats[i]`. */
  rowOf: number[];
  /** A chat's key (`keyOf`: its session id by default) → position in `chats`. */
  indexOf: Map<string, number>;
};

/**
 * Splits a place's chats into sections, keeping the service order within each
 * Empty sections are left out.
 * `allNow` (the Needs you and Running places) puts every chat in "now"; `hasMore` marks
 * the last section's count as partial; `keyOf` keys the rows (lists across
 * machines add the machine). Linear in the number of chats.
 */
export const groupChats = <T extends ChatSummary>(
  items: readonly T[],
  now: number,
  o: { allNow?: boolean; hasMore?: boolean; keyOf?: (chat: T) => string } = {},
): Grouped<T> => {
  const keyOf = o.keyOf ?? ((chat: T) => chat.sessionId);
  const buckets = new Map<SectionId, T[]>(ORDER.map((id) => [id, []]));
  for (const chat of items) {
    const id = o.allNow ? 'now' : recencySection(sidebarTime(chat), now);
    buckets.get(id)!.push(chat);
  }
  const present = ORDER.filter((id) => buckets.get(id)!.length > 0);
  const rows: ListRow<T>[] = [];
  const chats: T[] = [];
  const rowOf: number[] = [];
  const indexOf = new Map<string, number>();
  for (const id of present) {
    const members = buckets.get(id)!;
    rows.push({
      kind: 'header',
      key: `section:${id}`,
      section: id,
      label: SECTION_LABELS[id],
      count: members.length,
      more: !!o.hasMore && id === present.at(-1),
    });
    for (const chat of members) {
      const key = keyOf(chat);
      indexOf.set(key, chats.length);
      rowOf.push(rows.length);
      rows.push({ kind: 'chat', key, chat, index: chats.length, section: id });
      chats.push(chat);
    }
  }
  return { rows, chats, rowOf, indexOf };
};
