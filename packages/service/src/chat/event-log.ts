/**
 * Per-session replay buffer for the sequenced chat events (§4.5). Every
 * `chat.items` / `chat.status` event a live session emits is appended here and
 * stamped with the next sequence number; a reconnecting client asks for
 * "everything after N" via `since(N)`. The buffer keeps the last `capacity`
 * events; asking for anything older (or for a seq this log never issued, e.g.
 * one from before a service restart) returns `'gap'` and the client reloads
 * the chat with `chat.open`.
 */
import type { ChatItemsEvent, ChatStatusEvent } from '@pahub/protocol';

export type ChatEvent =
  { event: 'chat.items'; data: ChatItemsEvent } | { event: 'chat.status'; data: ChatStatusEvent };

type WithoutSeq<T> = Omit<T, 'seq'> & { seq?: number };

/** A `ChatEvent` before `append` stamps its seq (any seq passed in is overwritten). */
export type ChatEventDraft =
  | { event: 'chat.items'; data: WithoutSeq<ChatItemsEvent> }
  | { event: 'chat.status'; data: WithoutSeq<ChatStatusEvent> };

export const EVENT_LOG_CAPACITY = 5_000;

/**
 * Seq epochs: every service start numbers chat events from its own base,
 * `epoch × 2³²`, with the epoch persisted and advanced at each start. A seq a
 * client got from an earlier service process therefore lies outside every
 * log of this process and `since()` answers `'gap'` (→ reload), never events
 * that merely happen to share its number. 2²⁰ epochs × 2³² events per chat
 * stay below `Number.MAX_SAFE_INTEGER`.
 */
export const MAX_SEQ_EPOCH = 2 ** 20;
const EPOCH_SPAN = 2 ** 32;

/** The epoch after `previous` (1 when there is none or it is not a valid epoch). */
export const nextSeqEpoch = (previous: unknown): number =>
  typeof previous === 'number' &&
  Number.isInteger(previous) &&
  previous >= 1 &&
  previous <= MAX_SEQ_EPOCH
    ? (previous % MAX_SEQ_EPOCH) + 1
    : 1;

export const seqBaseForEpoch = (epoch: number): number => epoch * EPOCH_SPAN;

export class EventLog {
  private readonly buf: (ChatEvent | undefined)[];
  private last: number;
  private readonly first: number;

  /**
   * `startAfter`: the last seq a previous log for the same session issued, so
   * numbering stays monotonic when a chat is ended and later resumed in the
   * same service run. `since()` of anything before it is a `'gap'`.
   */
  constructor(
    private readonly capacity = EVENT_LOG_CAPACITY,
    startAfter = 0,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('EventLog capacity must be ≥ 1');
    if (!Number.isInteger(startAfter) || startAfter < 0)
      throw new Error('EventLog startAfter must be a non-negative integer');
    this.buf = new Array<ChatEvent | undefined>(capacity);
    this.last = startAfter;
    this.first = startAfter + 1;
  }

  /** Seq of the newest event (0 when empty). */
  get seq(): number {
    return this.last;
  }

  /** Stores the event stamped with the next seq and returns that seq. */
  append(e: ChatEventDraft): number {
    const seq = ++this.last;
    this.buf[(seq - 1) % this.capacity] = { event: e.event, data: { ...e.data, seq } } as ChatEvent;
    return seq;
  }

  /** The stamped event with this seq, if still buffered. */
  get(seq: number): ChatEvent | undefined {
    return seq >= this.oldest() && seq <= this.last
      ? this.buf[(seq - 1) % this.capacity]
      : undefined;
  }

  /** Events with seq > `seq`, in order; `'gap'` if some of them were evicted or never existed here. */
  since(seq: number): ChatEvent[] | 'gap' {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.last || seq < this.oldest() - 1) {
      return 'gap';
    }
    const out: ChatEvent[] = [];
    for (let s = seq + 1; s <= this.last; s++) out.push(this.buf[(s - 1) % this.capacity]!);
    return out;
  }

  private oldest(): number {
    return Math.max(this.first, this.last - this.capacity + 1);
  }
}
