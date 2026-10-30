/**
 * Turns SDK messages (live `SDKMessage`s and history `SessionMessage`s) into
 * stable protocol `ChatItem`s. Pure logic, no I/O.
 *
 * Forward compatibility is the point of this module: input is read leniently
 * (every field is checked at runtime, never trusted from the SDK typings).
 * Message types declared in SDK 0.3.314 are either rendered, mapped to a
 * `system` line, or deliberately non-visual (see `system-items.ts`); anything
 * outside that set, and any malformed shape, becomes a `kind: 'unknown'` item
 * carrying the raw JSON — never dropped, never a throw.
 *
 * Item ids
 * - A message that yields one item uses the SDK message `uuid`; a message with
 *   several content blocks uses `<uuid>:<block index>`. A user prompt (its text
 *   and image blocks together) is always the bare `<uuid>`, so `chat.fork` maps
 *   `upToItemId` back to the SDK `upToMessageId` by taking the part before `:`.
 * - Streaming exception: a text block that streamed via `stream_event` partials
 *   keeps the id it got while streaming — the `uuid` of the
 *   `content_block_start` event that opened it — and the final assistant
 *   message re-emits that id (streaming: false) instead of minting a new one,
 *   so finalisation replaces rather than duplicates. The final message's own
 *   uuid is unknown while streaming, hence this rule. Correlation key: the
 *   Anthropic API message id from `message_start` plus the block index. The CLI
 *   delivers one assistant message per completed block, so the normalizer
 *   counts blocks already finalised per API message id to recover the index.
 *   History (no partials) uses the plain uuid rule.
 * - `resolveItemId(sdkUuid)` maps an SDK message uuid (or `<uuid>:<index>`) to
 *   the id of the item that renders it: the streamed item's id for a finalised
 *   streamed block, otherwise the id built from the uuid itself.
 * - A streamed block that never gets its final message (API retry, interrupt)
 *   is closed — re-emitted with `streaming: false` — on the next
 *   `message_start` of the same stream, on `result`, and on `conversation_reset`.
 *
 * `replace: false` — every item is new (append). `replace: true` — at least one
 * item supersedes an earlier item with the same id. Consumers must always
 * upsert by id (one push can mix new and replacing items).
 */
import type { ChatItem, ChatStatus, ImageRef } from '@pahub/protocol';
import type { SDKMessage, SessionMessage } from '../sdk/adapter.js';
import {
  NON_VISUAL_SYSTEM_SUBTYPES,
  NON_VISUAL_TYPES,
  conversationResetText,
  systemLine,
} from './system-items.js';

export type PushResult = { items: ChatItem[]; replace: boolean };

/** Tool results longer than this are cut and flagged `resultTruncated`. */
export const RESULT_TEXT_LIMIT = 20_000;

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const NONE: PushResult = { items: [], replace: false };

export type NormalizerOptions = { now?: () => number };

export class Normalizer {
  private readonly now: () => number;
  private seq = 0;
  /** Open and finished tool calls, by `tool_use` id, so results can update them. */
  private readonly toolCalls = new Map<string, Item<'toolCall'>>();
  /** `tool_use` ids rendered as a `todo` item; their results are absorbed. */
  private readonly todoToolUseIds = new Set<string>();
  /** Current API message id of each stream, keyed by parent tool use ('' = main thread). */
  private readonly streamMessageId = new Map<string, string>();
  /** Open streaming text items by `<API message id>:<block index>`, with their stream key. */
  private readonly streaming = new Map<string, { item: Item<'assistantText'>; stream: string }>();
  /** Blocks finalised so far per API message id (= index of the next block). */
  private readonly blockCursor = new Map<string, number>();
  /** SDK uuid (or `<uuid>:<index>`) → id of the item rendering it, where they differ. */
  private readonly aliases = new Map<string, string>();
  /** Every item id emitted so far. */
  private readonly known = new Set<string>();

  constructor(opts: NormalizerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  push(m: SDKMessage | SessionMessage): PushResult {
    let r: PushResult;
    try {
      r = this.dispatch(m as unknown);
    } catch {
      // Defensive net: a shape we did not anticipate must not take the session down.
      r = this.unknown(m, isRec(m) ? (str(m.type) ?? 'unknown') : 'invalid');
    }
    this.remember(m, r.items);
    return r;
  }

  /**
   * The item id rendering SDK message `sdkUuid` (or a `<uuid>:<index>` block):
   * the streamed item's id for a finalised streamed block, the first item of a
   * multi-block message, else the uuid itself; `undefined` if never seen.
   */
  resolveItemId(sdkUuid: string): string | undefined {
    return this.aliases.get(sdkUuid) ?? (this.known.has(sdkUuid) ? sdkUuid : undefined);
  }

  /**
   * The SDK message uuid behind item `itemId` (for `forkSession`'s
   * `upToMessageId`): a streamed item's final message uuid when it has been
   * finalised, otherwise the part of the id before `:`.
   */
  messageUuidOf(itemId: string): string {
    let source = itemId;
    for (const [uuid, target] of this.aliases) {
      if (target !== itemId) continue;
      source = uuid;
      break;
    }
    return source.split(':')[0] ?? source;
  }

  private remember(m: unknown, items: ChatItem[]): void {
    for (const item of items) this.known.add(item.id);
    const uuid = isRec(m) ? str(m.uuid) : undefined;
    if (!uuid || items.length === 0 || this.known.has(uuid) || this.aliases.has(uuid)) return;
    const target = items.find((i) => i.id.startsWith(`${uuid}:`)) ?? items[0];
    if (target) this.aliases.set(uuid, target.id);
  }

  private dispatch(m: unknown): PushResult {
    if (!isRec(m)) return this.unknown(m, `invalid:${m === null ? 'null' : typeof m}`);
    const type = str(m.type);
    if (type && NON_VISUAL_TYPES.has(type)) return NONE;
    switch (type) {
      case 'stream_event':
        return this.onStream(m);
      case 'assistant':
        return this.onAssistant(m);
      case 'user':
        return this.onUser(m);
      case 'result':
        return this.withClosed(this.closeStreams(), this.result(m));
      case 'system':
        return this.onSystem(m);
      case 'conversation_reset': {
        const closed = this.closeStreams();
        this.resetConversation();
        return this.withClosed(closed, {
          kind: 'system',
          id: str(m.uuid) ?? this.localId(),
          level: 'info',
          text: conversationResetText(m),
        });
      }
      default:
        return this.unknown(m, type ?? 'unknown');
    }
  }

  /** Closes open streaming items (all, or those of one stream) and returns them finalised. */
  private closeStreams(stream?: string): ChatItem[] {
    const closed: ChatItem[] = [];
    for (const [key, entry] of this.streaming) {
      if (stream !== undefined && entry.stream !== stream) continue;
      this.streaming.delete(key);
      closed.push({ ...entry.item, streaming: false });
    }
    return closed;
  }

  private withClosed(closed: ChatItem[], item: ChatItem): PushResult {
    return { items: [...closed, item], replace: closed.length > 0 };
  }

  /** `/clear` and friends: earlier tool calls and streams can no longer be continued. */
  private resetConversation(): void {
    this.toolCalls.clear();
    this.todoToolUseIds.clear();
    this.streamMessageId.clear();
    this.streaming.clear();
    this.blockCursor.clear();
  }

  // ── stream_event partials ───────────────────────────────────────────────

  private onStream(m: Rec): PushResult {
    const event = m.event;
    if (!isRec(event)) return NONE; // the final assistant message still carries the content
    const streamKey = str(m.parent_tool_use_id) ?? '';
    const messageId = this.streamMessageId.get(streamKey);
    const index = num(event.index);
    switch (event.type) {
      case 'message_start': {
        // Blocks of this stream's previous API message that never got a final
        // message (API retry, interrupt) are closed so none stays "streaming".
        const closed = this.closeStreams(streamKey);
        const id = isRec(event.message) ? str(event.message.id) : undefined;
        if (id) this.streamMessageId.set(streamKey, id);
        else this.streamMessageId.delete(streamKey);
        return { items: closed, replace: closed.length > 0 };
      }
      case 'content_block_start': {
        const block = event.content_block;
        if (!messageId || index === undefined || !isRec(block) || block.type !== 'text') {
          return NONE;
        }
        const item: Item<'assistantText'> = {
          kind: 'assistantText',
          id: str(m.uuid) ?? this.localId(),
          markdown: str(block.text) ?? '',
          streaming: true,
          ...this.parentOf(m),
        };
        this.streaming.set(`${messageId}:${index}`, { item, stream: streamKey });
        return { items: [item], replace: false };
      }
      case 'content_block_delta': {
        const delta = event.delta;
        const key = `${messageId}:${index}`;
        const entry = this.streaming.get(key);
        if (!entry || !isRec(delta) || delta.type !== 'text_delta') return NONE;
        const next = { ...entry.item, markdown: entry.item.markdown + (str(delta.text) ?? '') };
        this.streaming.set(key, { item: next, stream: streamKey });
        return { items: [next], replace: true };
      }
      default:
        // content_block_stop, message_delta, message_stop, thinking/tool-input deltas, and
        // future partial events: the final assistant message carries their content.
        return NONE;
    }
  }

  // ── assistant ───────────────────────────────────────────────────────────

  private onAssistant(m: Rec): PushResult {
    const msg = m.message;
    if (!isRec(msg) || !Array.isArray(msg.content)) return this.unknown(m, 'assistant');
    const content: unknown[] = msg.content;
    const base = str(m.uuid) ?? this.localId();
    const apiId = str(msg.id);
    const cursor = apiId ? (this.blockCursor.get(apiId) ?? 0) : 0;
    if (apiId) this.blockCursor.set(apiId, cursor + content.length);

    const items: ChatItem[] = [];
    let replace = false;
    content.forEach((block, i) => {
      const id = content.length === 1 ? base : `${base}:${i}`;
      if (isRec(block) && block.type === 'text' && typeof block.text === 'string') {
        const key = `${apiId}:${cursor + i}`;
        const streamed = apiId ? this.streaming.get(key)?.item : undefined;
        if (streamed) {
          this.streaming.delete(key);
          replace = true;
          if (id !== streamed.id) this.aliases.set(id, streamed.id);
          items.push({ ...streamed, markdown: block.text, streaming: false });
        } else {
          items.push({
            kind: 'assistantText',
            id,
            markdown: block.text,
            streaming: false,
            ...this.parentOf(m),
          });
        }
      } else if (isRec(block) && block.type === 'thinking' && typeof block.thinking === 'string') {
        items.push({ kind: 'thinking', id, text: block.thinking, ...this.parentOf(m) });
      } else if (isRec(block) && block.type === 'tool_use') {
        items.push(this.toolUse(m, block, id));
      } else {
        items.push(this.unknownBlock(m, block, id));
      }
    });
    return { items, replace };
  }

  private toolUse(m: Rec, block: Rec, id: string): ChatItem {
    const toolUseId = str(block.id);
    const name = str(block.name);
    if (!toolUseId || !name) return this.unknownBlock(m, block, id);
    const todos = name === 'TodoWrite' ? parseTodos(block.input) : undefined;
    if (todos) {
      this.todoToolUseIds.add(toolUseId);
      return { kind: 'todo', id, todos, ...this.parentOf(m) };
    }
    const item: Item<'toolCall'> = {
      kind: 'toolCall',
      id,
      toolUseId,
      name,
      input: block.input,
      status: 'running',
      parentToolUseId: str(m.parent_tool_use_id) ?? null,
    };
    this.toolCalls.set(toolUseId, item);
    return item;
  }

  // ── user ────────────────────────────────────────────────────────────────

  private onUser(m: Rec): PushResult {
    const msg = m.message;
    if (!isRec(msg)) return this.unknown(m, 'user');
    const base = str(m.uuid) ?? this.localId();
    const content = msg.content;
    if (typeof content === 'string') return this.one(this.userItem(m, base, content, []));
    if (!Array.isArray(content)) return this.unknown(m, 'user');

    const texts: string[] = [];
    const images: ImageRef[] = [];
    const items: ChatItem[] = [];
    let replace = false;
    content.forEach((block: unknown, i) => {
      const id = content.length === 1 ? base : `${base}:${i}`;
      if (isRec(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
        return;
      }
      const image = isRec(block) && block.type === 'image' ? parseImage(block.source) : undefined;
      if (image) {
        images.push(image);
        return;
      }
      if (isRec(block) && block.type === 'tool_result') {
        const r = this.toolResult(block, id);
        if (r.replaced) replace = true;
        if (r.item) items.push(r.item);
        return;
      }
      items.push(this.unknownBlock(m, block, id));
    });
    if (texts.length > 0 || images.length > 0) {
      items.unshift(this.userItem(m, base, texts.join('\n'), images));
    }
    return { items, replace };
  }

  private userItem(m: Rec, id: string, text: string, images: ImageRef[]): Item<'user'> {
    const parsed = Date.parse(str(m.timestamp) ?? '');
    return {
      kind: 'user',
      id,
      text,
      ...(images.length > 0 ? { images } : {}),
      ts: Number.isNaN(parsed) ? this.now() : parsed,
      ...this.parentOf(m),
    };
  }

  private toolResult(block: Rec, id: string): { item?: ChatItem; replaced: boolean } {
    const toolUseId = str(block.tool_use_id);
    const isError = block.is_error === true;
    const text = resultText(block.content);
    if (toolUseId && this.todoToolUseIds.has(toolUseId)) {
      // The todo item already shows the list; only a failure is worth surfacing.
      return isError
        ? { item: { kind: 'system', id, level: 'warning', text }, replaced: false }
        : { replaced: false };
    }
    const call = toolUseId ? this.toolCalls.get(toolUseId) : undefined;
    if (!call) return { item: this.unknownBlock(undefined, block, id), replaced: false };
    const truncated = text.length > RESULT_TEXT_LIMIT;
    const next: Item<'toolCall'> = {
      ...call,
      status: isError ? 'error' : 'ok',
      resultText: truncated ? text.slice(0, RESULT_TEXT_LIMIT) : text,
      resultTruncated: truncated,
    };
    this.toolCalls.set(next.toolUseId, next);
    return { item: next, replaced: true };
  }

  // ── system / result ─────────────────────────────────────────────────────

  private onSystem(m: Rec): PushResult {
    const subtype = str(m.subtype);
    if (!subtype) return this.unknown(m, 'system'); // e.g. a history SessionMessage system entry
    if (NON_VISUAL_SYSTEM_SUBTYPES.has(subtype)) return NONE;
    if (subtype === 'compact_boundary') {
      return this.one({ kind: 'compactBoundary', id: str(m.uuid) ?? this.localId() });
    }
    const line = systemLine(subtype, m);
    if (line === undefined) return this.unknown(m, `system:${subtype}`);
    if (line === null) return NONE;
    return this.one({ kind: 'system', id: str(m.uuid) ?? this.localId(), ...line });
  }

  private result(m: Rec): Item<'result'> {
    const durationMs = num(m.duration_ms);
    const costUsd = num(m.total_cost_usd);
    return {
      kind: 'result',
      id: str(m.uuid) ?? this.localId(),
      isError: m.is_error === true || (str(m.subtype)?.startsWith('error') ?? false),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(m.usage === undefined ? {} : { usage: m.usage }),
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private one(item: ChatItem): PushResult {
    return { items: [item], replace: false };
  }

  private unknown(raw: unknown, sdkType: string): PushResult {
    const id = (isRec(raw) && str(raw.uuid)) || this.localId();
    return this.one({ kind: 'unknown', id, sdkType, raw, ...this.parentOf(raw) });
  }

  private unknownBlock(m: unknown, block: unknown, id: string): Item<'unknown'> {
    const type = isRec(block) ? (str(block.type) ?? 'unknown') : 'invalid';
    return { kind: 'unknown', id, sdkType: `block:${type}`, raw: block, ...this.parentOf(m) };
  }

  private parentOf(m: unknown): { parentToolUseId?: string } {
    const p = isRec(m) ? str(m.parent_tool_use_id) : undefined;
    return p ? { parentToolUseId: p } : {};
  }

  private localId(): string {
    return `local:${++this.seq}`;
  }
}

const parseTodos = (input: unknown): Item<'todo'>['todos'] | undefined => {
  if (!isRec(input) || !Array.isArray(input.todos)) return undefined;
  return input.todos.map((t: unknown) => ({
    content: isRec(t) ? (str(t.content) ?? '') : String(t),
    status: isRec(t) ? (str(t.status) ?? 'unknown') : 'unknown',
  }));
};

const parseImage = (source: unknown): ImageRef | undefined => {
  if (!isRec(source) || source.type !== 'base64') return undefined;
  const mediaType = str(source.media_type);
  const data = str(source.data);
  return mediaType && data !== undefined ? { mediaType, data } : undefined;
};

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((b: unknown) =>
      isRec(b) && b.type === 'text' && typeof b.text === 'string'
        ? b.text
        : `[${isRec(b) ? (str(b.type) ?? 'block') : 'block'}]`,
    )
    .join('\n');
};

/** Chat status after `m`, given the current one (§6.2). Unrecognised states map to 'unknown'. */
export const deriveStatus = (m: SDKMessage, current: ChatStatus): ChatStatus => {
  const x: unknown = m;
  if (!isRec(x)) return current;
  if (x.type === 'result') return 'idle';
  if (x.type === 'system' && x.subtype === 'session_state_changed') {
    switch (x.state) {
      case 'running':
        return 'working';
      case 'idle':
        return 'idle';
      case 'requires_action':
        return 'needsYou';
      default:
        return 'unknown';
    }
  }
  return current;
};
