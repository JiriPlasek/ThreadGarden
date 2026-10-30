import type { ChatSummary } from '@pahub/protocol';
import { isYourTurn } from './StatusIcon.svelte';

/**
 * Recency sections of the chat list (v1.2 §2): the "now" section (chats that
 * need the user or are running), then by last activity.
 */
export type SectionId = 'now' | 'day' | 'week' | 'month' | 'older';

export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  now: 'Now',
  day: 'Last 24 hours',
  week: 'Last 7 days',
  month: 'Last 30 days',
  older: 'Older',
};

const ORDER: readonly SectionId[] = ['now', 'day', 'week', 'month', 'older'];

export const DAY_MS = 86_400_000;

/**
 * Needs you, "Your turn", working, or (Ruling R29) running background tasks.
 * Statuses this build does not know go by their recency.
 */
export const isNow = (chat: ChatSummary): boolean =>
  chat.status === 'needsYou' ||
  chat.status === 'working' ||
  (chat.runningTasks ?? 0) > 0 ||
  isYourTurn(chat.status, chat.unread);

/**
 * The recency section of a last-activity time. A boundary belongs to the newer
 * section (exactly 24 h old is "Last 24 hours"); clock skew reads as recent and
 * a missing time (0, NaN) as older.
 */
export const recencySection = (lastActivity: number, now: number): SectionId => {
  if (!Number.isFinite(lastActivity) || lastActivity <= 0) return 'older';
  const age = now - lastActivity;
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

export type ChatRow = {
  kind: 'chat';
  key: string;
  chat: ChatSummary;
  /** Position among the chats, in display order. */
  index: number;
  section: SectionId;
};

export type ListRow = HeaderRow | ChatRow;

export type Grouped = {
  /** Headers and chats, as the virtual list shows them. */
  rows: ListRow[];
  /** The chats in display order (what keyboard navigation walks). */
  chats: ChatSummary[];
  /** `rowOf[i]`: the row index of `chats[i]`. */
  rowOf: number[];
  /** Session id → position in `chats`. */
  indexOf: Map<string, number>;
};

/**
 * Splits a place's chats into sections, keeping the service order within each
 * (so "now" keeps the status order). Empty sections are left out. `allNow`
 * (the Needs you and Running places) puts every chat in "now"; `hasMore` marks
 * the last section's count as partial. Linear in the number of chats.
 */
export const groupChats = (
  items: readonly ChatSummary[],
  now: number,
  o: { allNow?: boolean; hasMore?: boolean } = {},
): Grouped => {
  const buckets = new Map<SectionId, ChatSummary[]>(ORDER.map((id) => [id, []]));
  for (const chat of items) {
    const id = o.allNow || isNow(chat) ? 'now' : recencySection(chat.lastActivity, now);
    buckets.get(id)!.push(chat);
  }
  const present = ORDER.filter((id) => buckets.get(id)!.length > 0);
  const rows: ListRow[] = [];
  const chats: ChatSummary[] = [];
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
      indexOf.set(chat.sessionId, chats.length);
      rowOf.push(rows.length);
      rows.push({ kind: 'chat', key: chat.sessionId, chat, index: chats.length, section: id });
      chats.push(chat);
    }
  }
  return { rows, chats, rowOf, indexOf };
};
