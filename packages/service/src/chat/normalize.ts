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
import type { ChatItem, ChatStatus, ImageRef } from '@threadgarden/protocol';
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

/** A copy of `call` no longer marked as waiting on its permission check. */
const unchecked = (call: Item<'toolCall'>): Item<'toolCall'> => {
  const next = { ...call };
  delete next.checkingPermission;
  return next;
};

export type NormalizerOptions = {
  now?: () => number;
  /**
   * For history, which has no `result` messages: end every turn with a footer
   * item built from its replies, before the next prompt and on `finish()`.
   * Live, the `result` is the footer.
   */
  turnEnds?: boolean;
};

/** The last main-thread reply, for the chat header when no process reports one. */
export type LastReply = {
  /** When it arrived: its timestamp, live the time it was pushed; unknown for history without one. */
  at?: number;
  /** Prompt tokens the next request re-sends: its input, cache reads and writes, and output. */
  contextTokens: number;
  /** The API model id that answered. */
  model?: string;
  /** How long the prompt cache it used lives: the lifetime it was last written with. */
  cacheTtlMs: number;
  /**
   * A compaction came after it (Claude Code's idle compaction, `/compact`):
   * the next message sends the summary, not this context.
   */
  compacted?: true;
};

export const CACHE_TTL_5M_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
const USAGE_KEYS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
] as const;

/** The turn being read: its prompt's time and its main-thread replies' usage, by API message. */
type Turn = {
  startedAt?: number;
  lastUuid?: string;
  lastAt?: number;
  usage: Map<string, Rec>;
};

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
  /** A `compact_boundary` was shown and its summary message has not arrived yet. */
  private compactPending = false;
  private readonly turnEnds: boolean;
  private turn: Turn = { usage: new Map() };
  private last: LastReply | undefined;
  /** The prompt cache's lifetime as last written (a read keeps it). */
  private cacheTtlMs = CACHE_TTL_5M_MS;

  constructor(opts: NormalizerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.turnEnds = opts.turnEnds ?? false;
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
    return this.trackTurn(m as unknown, r);
  }

  /** History's last turn has no next prompt: its footer, if it had a reply. */
  finish(): PushResult {
    const footer = this.endTurn();
    if (!footer) return NONE;
    this.known.add(footer.id);
    return this.one(footer);
  }

  /** The last main-thread reply seen; undefined before the first. */
  lastReply(): LastReply | undefined {
    return this.last ? { ...this.last } : undefined;
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
        this.compactPending = false;
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
    this.compactPending = false;
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
    const cli = this.cliUserMessage(m, base, onlyText(content));
    if (cli) return cli;
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

  /**
   * User-role messages the CLI writes itself, rendered the way the terminal
   * shows them rather than as raw markup (verified against Claude Code
   * 2.1.314 with the real suite):
   * - the compaction summary (`isSynthetic` live, right after the
   *   `compact_boundary`; `isCompactSummary` in history, which has no
   *   boundary message) → the boundary divider, shown once;
   * - a slash command entry (`<command-name>/x</command-name>…<command-args>`)
   *   → the user's `/x args`;
   * - `<bash-input>` (a `!` shell command) → `! command`;
   * - local command and `!` shell output (`<local-command-stdout>`,
   *   `<bash-stderr>`, …) → a system line, or nothing when empty;
   * - a loaded skill's instructions (`isSynthetic` live; `isMeta` in the
   *   transcript, whose history read drops them) → a collapsed system item
   *   "Skill: <name>", nested under a subagent that loaded it;
   * - envelopes the CLI injects as user turns (Ruling R27: background-task
   *   notifications, subagent hand-backs, … — see `INJECTED`) → a collapsed
   *   system item with a short label; the local-command caveat → nothing.
   * Anything else returns undefined and renders as a normal user message.
   */
  private cliUserMessage(m: Rec, id: string, text: string | undefined): PushResult | undefined {
    if (m.isCompactSummary === true || (m.isSynthetic === true && this.compactPending)) {
      const shown = this.compactPending;
      this.compactPending = false;
      return shown ? NONE : this.one({ kind: 'compactBoundary', id });
    }
    if (text === undefined) return undefined;
    const skill = m.isSynthetic === true || m.isMeta === true ? skillLabel(text) : undefined;
    if (skill !== undefined) {
      return this.one({
        kind: 'system',
        id,
        level: 'info',
        text: skill,
        detail: text,
        ...this.parentOf(m),
      });
    }
    const injected = parseInjected(text);
    if (injected === null) return NONE;
    if (injected !== undefined) {
      return this.one({ kind: 'system', id, level: 'info', ...injected });
    }
    const command = parseCommand(text);
    if (command !== undefined) return this.one(this.userItem(m, id, command, []));
    const shell = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(text);
    if (shell) return this.one(this.userItem(m, id, `! ${shell[1]!.trim()}`, []));
    const output = parseCommandOutput(text);
    if (output === undefined) return undefined;
    if (output.text === '') return NONE;
    return this.one({
      kind: 'system',
      id,
      level: output.error ? 'warning' : 'info',
      text: output.text,
    });
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
      ...unchecked(call),
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
      this.compactPending = true; // the summary that follows is not shown again
      return this.one({ kind: 'compactBoundary', id: str(m.uuid) ?? this.localId() });
    }
    if (subtype === 'permission_check_status') return this.permissionCheck(m);
    const line = systemLine(subtype, m);
    if (line === undefined) return this.unknown(m, `system:${subtype}`);
    if (line === null) return NONE;
    return this.one({ kind: 'system', id: str(m.uuid) ?? this.localId(), ...line });
  }

  /**
   * `system/permission_check_status` (outside the SDK 0.3.314 union; CLI 2.1.319
   * sends it): a running tool call has waited about 4 s on its automatic
   * permission check (`checking`), or that wait is over (`done`). Display-only:
   * it marks the call's row, never renders by itself, and a frame for a call
   * that is not running is dropped.
   */
  private permissionCheck(m: Rec): PushResult {
    const toolUseId = str(m.tool_use_id);
    const call = toolUseId ? this.toolCalls.get(toolUseId) : undefined;
    if (!call || call.status !== 'running') return NONE;
    const checking = m.status === 'checking';
    if (checking === (call.checkingPermission === true)) return NONE;
    const next: Item<'toolCall'> = checking
      ? { ...call, checkingPermission: true }
      : unchecked(call);
    this.toolCalls.set(next.toolUseId, next);
    return { items: [next], replace: true };
  }

  private result(m: Rec): Item<'result'> {
    const durationMs = num(m.duration_ms);
    const costUsd = num(m.total_cost_usd);
    // The id history's footer for this turn gets (`endTurn`), so a chat's view shows one.
    const lastUuid = this.turn.lastUuid;
    this.turn = { usage: new Map() };
    return {
      kind: 'result',
      id: lastUuid ? `turn-end:${lastUuid}` : (str(m.uuid) ?? this.localId()),
      ts: this.now(),
      isError: m.is_error === true || (str(m.subtype)?.startsWith('error') ?? false),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(m.usage === undefined ? {} : { usage: m.usage }),
    };
  }

  // ── turns ───────────────────────────────────────────────────────────────

  /**
   * Follows the turn `m` belongs to: a main-thread reply adds its usage (once
   * per API message: each block of one repeats it) and becomes the last reply.
   * With `turnEnds`, a prompt (not a message queued during the turn) ends the
   * turn before it: the footer goes first.
   */
  private trackTurn(m: unknown, r: PushResult): PushResult {
    if (!isRec(m)) return r;
    if (m.type === 'assistant' && !m.parent_tool_use_id && isRec(m.message)) {
      this.onReply(m, m.message);
      return r;
    }
    if (this.last && r.items.some((i) => i.kind === 'compactBoundary')) {
      this.last = { ...this.last, compacted: true };
    }
    if (!this.turnEnds || m.isQueuedCommand === true) return r;
    const prompt = r.items.find((i): i is Item<'user'> => i.kind === 'user');
    if (!prompt) return r;
    const footer = this.endTurn();
    const startedAt = this.timeOf(m);
    this.turn = { ...(startedAt === undefined ? {} : { startedAt }), usage: new Map() };
    if (!footer) return r;
    this.known.add(footer.id);
    return { items: [footer, ...r.items], replace: r.replace };
  }

  /**
   * When `m` happened: its timestamp; live (no timestamps) the time it arrived.
   * History without one has no time: a footer or header shows none rather
   * than the time it was read.
   */
  private timeOf(m: Rec): number | undefined {
    const parsed = Date.parse(str(m.timestamp) ?? '');
    if (!Number.isNaN(parsed)) return parsed;
    return this.turnEnds ? undefined : this.now();
  }

  private onReply(m: Rec, msg: Rec): void {
    const uuid = str(m.uuid);
    const at = this.timeOf(m);
    if (uuid) this.turn.lastUuid = uuid;
    if (at === undefined) delete this.turn.lastAt;
    else this.turn.lastAt = at;
    const usage = msg.usage;
    if (!isRec(usage)) return;
    this.turn.usage.set(str(msg.id) ?? uuid ?? this.localId(), usage);
    const written = isRec(usage.cache_creation) ? usage.cache_creation : {};
    if ((num(written.ephemeral_1h_input_tokens) ?? 0) > 0) this.cacheTtlMs = CACHE_TTL_1H_MS;
    else if ((num(usage.cache_creation_input_tokens) ?? 0) > 0) this.cacheTtlMs = CACHE_TTL_5M_MS;
    const model = str(msg.model);
    this.last = {
      ...(at === undefined ? {} : { at }),
      contextTokens: USAGE_KEYS.reduce((n, k) => n + (num(usage[k]) ?? 0), 0),
      ...(model === undefined ? {} : { model }),
      cacheTtlMs: this.cacheTtlMs,
    };
  }

  /** The footer of the turn read so far (history), or undefined when it had no reply. */
  private endTurn(): Item<'result'> | undefined {
    const { startedAt, lastUuid, lastAt, usage } = this.turn;
    if (!lastUuid) return undefined;
    const sum = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])) as Record<
      (typeof USAGE_KEYS)[number],
      number
    >;
    for (const u of usage.values()) for (const k of USAGE_KEYS) sum[k] += num(u[k]) ?? 0;
    return {
      kind: 'result',
      id: `turn-end:${lastUuid}`,
      isError: false,
      ...(startedAt !== undefined && lastAt !== undefined && lastAt >= startedAt
        ? { durationMs: lastAt - startedAt }
        : {}),
      ...(lastAt === undefined ? {} : { ts: lastAt }),
      ...(usage.size > 0 ? { usage: sum } : {}),
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

/** The text of a user message made only of text (a string, or text blocks); else undefined. */
const onlyText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const b of content as unknown[]) {
    if (!isRec(b) || b.type !== 'text' || typeof b.text !== 'string') return undefined;
    parts.push(b.text);
  }
  return parts.join('\n');
};

const tag = (text: string, name: string): string | undefined =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];

/** `<command-name>/x</command-name>…<command-args>a</command-args>` → `/x a`; else undefined. */
const parseCommand = (text: string): string | undefined => {
  if (!/^\s*<command-(name|message)>/.test(text)) return undefined;
  const name = tag(text, 'command-name')?.trim();
  if (!name) return undefined;
  const args = tag(text, 'command-args')?.trim() ?? '';
  const command = name.startsWith('/') ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};
/** The XML entities some CLI versions write inside envelope fields. */
const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? '');

/**
 * Ruling R27: user-role entries the CLI injects rather than the user typing
 * them, recognised by a closed list of envelope tags (names as in SDK 0.3.314).
 * Each maps its inner text to the short label of a collapsed system item;
 * `null` means "not shown" (the terminal hides it too).
 */
const INJECTED: Record<string, ((inner: string) => string) | null> = {
  'task-notification': (inner) => {
    const summary = decodeEntities(tag(inner, 'summary') ?? '').trim();
    if (summary) return summary;
    const status = tag(inner, 'status')?.trim();
    return status ? `Background task ${status}` : 'Background task notification';
  },
  'agent-message': () => 'Report from a subagent',
  'teammate-message': () => 'Message from a teammate',
  'cross-session-message': () => 'Message from another session',
  'coordinator-relay': () => 'Message relayed by the coordinator',
  'local-command-caveat': null,
};
const INJECTED_LABEL_MAX = 200;
const ENVELOPE = /^\s*<([a-z][a-z-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>\s*$/;

/**
 * A message that is exactly one injected envelope → its label and full text
 * (`detail`: the whole notification, or a hand-back's inner text); `null` for
 * one that is not shown; undefined for anything else (shown as typed).
 */
const parseInjected = (text: string): { text: string; detail: string } | null | undefined => {
  const m = ENVELOPE.exec(text);
  const name = m?.[1];
  if (!m || name === undefined || !(name in INJECTED)) return undefined;
  const label = INJECTED[name];
  if (label === null || label === undefined) return null;
  const inner = (m[2] ?? '').trim();
  const short = label(inner).replace(/\s+/g, ' ');
  return {
    text: short.length > INJECTED_LABEL_MAX ? `${short.slice(0, INJECTED_LABEL_MAX)}…` : short,
    // A notification's fields are all worth seeing; a hand-back is just its text.
    detail: name === 'task-notification' ? text.trim() : inner,
  };
};

const SKILL_HEADER = /^Base directory for this skill: *([^\n]*)/;

/**
 * A loaded skill's instructions (`Base directory for this skill: <dir>` and
 * the SKILL.md body) → "Skill: <folder name>"; else undefined. Only asked of
 * messages the CLI marks synthetic or meta, never of what the user typed.
 */
const skillLabel = (text: string): string | undefined => {
  const dir = SKILL_HEADER.exec(text)?.[1]?.trim();
  if (dir === undefined) return undefined;
  const name = dir
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1);
  return name ? `Skill: ${name}` : 'Skill';
};

const OUTPUT_BLOCK = /<(local-command|bash)-(stdout|stderr)>([\s\S]*?)<\/\1-\2>/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Text made only of local-command / shell output blocks → their joined content
 * (ANSI colours removed) and whether a stderr block has text; else undefined.
 */
const parseCommandOutput = (text: string): { text: string; error: boolean } | undefined => {
  const blocks = [...text.matchAll(OUTPUT_BLOCK)];
  if (blocks.length === 0 || text.replace(OUTPUT_BLOCK, '').trim() !== '') return undefined;
  const parts = blocks.map((b) => ({
    error: b[2] === 'stderr',
    text: (b[3] ?? '').replace(ANSI, '').trim(),
  }));
  return {
    text: parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join('\n'),
    error: parts.some((p) => p.error && p.text),
  };
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
