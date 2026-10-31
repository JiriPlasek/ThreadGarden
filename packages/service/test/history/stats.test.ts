import { describe, expect, it } from 'vitest';
import { StatsCollector, localDay } from '../../src/history/stats.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';

/** Local times, so the tests hold in every time zone. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 9, day, hour, minute).getTime();
const iso = (t: number): string => new Date(t).toISOString();

const raw = (m: Record<string, unknown>): SessionMessage =>
  ({ uuid: 'u', session_id: 's', parent_tool_use_id: null, ...m }) as unknown as SessionMessage;

const user = (t: number, content: unknown, extra: Record<string, unknown> = {}) =>
  raw({ type: 'user', timestamp: iso(t), message: { role: 'user', content }, ...extra });

const assistant = (
  t: number,
  o: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown[];
    extra?: Record<string, unknown>;
  } = {},
) =>
  raw({
    type: 'assistant',
    timestamp: iso(t),
    message: {
      ...(o.id ? { id: o.id } : {}),
      role: 'assistant',
      model: o.model ?? 'claude-sonnet-4-5',
      content: o.content ?? [{ type: 'text', text: 'ok' }],
      ...(o.usage ? { usage: o.usage } : {}),
    },
    ...o.extra,
  });

const collect = (messages: SessionMessage[], fallback = at(1, 0)) => {
  const c = new StatsCollector(fallback);
  c.add(messages);
  return c.result();
};

describe('localDay', () => {
  it('formats the local calendar day', () => {
    expect(localDay(at(5, 23, 59))).toBe('2026-10-05');
    expect(localDay(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });
});

describe('StatsCollector', () => {
  it('counts messages and tokens per local day and model', () => {
    const s = collect([
      user(at(30, 9), 'hello'),
      assistant(at(30, 9, 1), {
        id: 'm1',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 40,
        },
      }),
      user(at(31, 14), [{ type: 'text', text: 'next day' }]),
      assistant(at(31, 14, 2), {
        id: 'm2',
        model: 'claude-opus-4-1',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ]);
    expect(s.days).toEqual(
      expect.arrayContaining([
        {
          day: '2026-10-30',
          model: '',
          userMessages: 1,
          assistantMessages: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          day: '2026-10-30',
          model: 'claude-sonnet-4-5',
          userMessages: 0,
          assistantMessages: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheCreationTokens: 40,
        },
        expect.objectContaining({ day: '2026-10-31', model: '', userMessages: 1 }),
        expect.objectContaining({
          day: '2026-10-31',
          model: 'claude-opus-4-1',
          assistantMessages: 1,
          outputTokens: 2,
        }),
      ]),
    );
    expect(s.days).toHaveLength(4);
    expect(s.firstAt).toBe(at(30, 9));
    expect(s.lastAt).toBe(at(31, 14, 2));
    expect(s.hours).toEqual(
      expect.arrayContaining([
        { day: '2026-10-30', hour: 9, messages: 2 },
        { day: '2026-10-31', hour: 14, messages: 2 },
      ]),
    );
  });

  it('counts one API message once, with its last usage, across split entries', () => {
    // Claude Code writes one entry per content block, each repeating the message id and usage.
    const s = collect([
      assistant(at(30, 9), {
        id: 'm1',
        content: [{ type: 'thinking', thinking: '…' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
      assistant(at(30, 9), {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        usage: { input_tokens: 5, output_tokens: 30 },
      }),
    ]);
    expect(s.days).toEqual([
      expect.objectContaining({ assistantMessages: 1, inputTokens: 5, outputTokens: 30 }),
    ]);
    expect(s.tools).toEqual([{ day: '2026-10-30', name: 'Read', calls: 1 }]);
  });

  it('counts tool calls by name and Agent/Task calls by subagent type', () => {
    const s = collect([
      assistant(at(30, 10), {
        id: 'a',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 't3', name: 'Agent', input: { subagent_type: 'Explore' } },
          { type: 'tool_use', id: 't4', name: 'Task', input: { subagent_type: 'Plan' } },
          { type: 'tool_use', id: 't5', name: 'Agent', input: {} },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, // repeated id
        ],
      }),
    ]);
    const tools = Object.fromEntries(s.tools.map((t) => [t.name, t.calls]));
    expect(tools).toEqual({ Bash: 2, Agent: 2, Task: 1 });
    const agents = Object.fromEntries(s.agents.map((a) => [a.type, a.calls]));
    expect(agents).toEqual({ Explore: 1, Plan: 1, 'general-purpose': 1 });
  });

  it('does not count tool results, CLI envelopes, meta or subagent prompts as user messages', () => {
    const s = collect([
      user(at(30, 9), 'real question'),
      user(at(30, 9), [{ type: 'tool_result', tool_use_id: 't', content: 'out' }]),
      user(at(30, 9), '<task-notification><task-id>x</task-id></task-notification>'),
      user(at(30, 9), '<local-command-stdout></local-command-stdout>'),
      user(
        at(30, 9),
        '<command-message>review</command-message>\n<command-name>/review</command-name>',
      ),
      user(at(30, 9), 'caveat', { isMeta: true }),
      user(at(30, 9), 'summary', { isCompactSummary: true }),
      user(at(30, 9), 'subagent prompt', { parent_tool_use_id: 'toolu_1' }),
      user(at(30, 9), 'sidechain prompt', { isSidechain: true }),
      user(at(30, 9), [{ type: 'image', source: { type: 'base64', data: 'AA==' } }]),
    ]);
    expect(s.days).toEqual([expect.objectContaining({ model: '', userMessages: 3 })]);
  });

  it('counts subagent tokens and tools, but not subagent replies as messages', () => {
    const s = collect([
      assistant(at(30, 9), {
        id: 'sub',
        usage: { output_tokens: 7 },
        content: [{ type: 'tool_use', id: 't', name: 'Grep', input: {} }],
        extra: { parent_tool_use_id: 'toolu_1' },
      }),
    ]);
    expect(s.days).toEqual([
      expect.objectContaining({
        assistantMessages: 0,
        outputTokens: 7,
        model: 'claude-sonnet-4-5',
      }),
    ]);
    expect(s.tools).toEqual([{ day: '2026-10-30', name: 'Grep', calls: 1 }]);
    expect(s.hours).toEqual([]);
  });

  it('skips synthetic replies and is lenient with odd shapes', () => {
    const s = collect([
      assistant(at(30, 9), { model: '<synthetic>', usage: { output_tokens: 3 } }),
      raw({ type: 'assistant', message: null }),
      raw({ type: 'assistant', message: { content: 'not an array', usage: 'x' } }),
      raw({
        type: 'assistant',
        timestamp: 'garbage',
        message: { content: [null, 5, { type: 'tool_use' }], usage: { output_tokens: -4 } },
      }),
      raw({ type: 'user', message: 7 }),
      raw({ type: 'system', subtype: 'init' }),
      raw({ type: 'mystery', message: { content: [] } }),
    ]);
    // The two shapeless assistant entries count as replies of an unknown model, at the fallback time.
    expect(s.days).toEqual([
      expect.objectContaining({
        day: '2026-10-01',
        model: 'unknown',
        assistantMessages: 2,
        outputTokens: 0,
      }),
    ]);
    expect(s.tools).toEqual([]);
  });

  it('places messages without a timestamp at the previous one, else the fallback', () => {
    const s = collect(
      [
        raw({ type: 'user', message: { content: 'first' } }),
        user(at(30, 9), 'second'),
        raw({ type: 'user', message: { content: 'third' } }),
      ],
      at(2, 8),
    );
    expect(s.hours).toEqual(
      expect.arrayContaining([
        { day: '2026-10-02', hour: 8, messages: 1 },
        { day: '2026-10-30', hour: 9, messages: 2 },
      ]),
    );
    expect(s.firstAt).toBe(at(2, 8));
  });

  it('accepts the messages in several slices', () => {
    const c = new StatsCollector(at(1, 0));
    c.add([user(at(30, 9), 'a')]);
    c.add([assistant(at(30, 9), { id: 'm', usage: { output_tokens: 1 } })]);
    c.add([assistant(at(30, 9), { id: 'm', usage: { output_tokens: 9 } })]);
    const s = c.result();
    expect(s.days.find((d) => d.model !== '')).toMatchObject({
      assistantMessages: 1,
      outputTokens: 9,
    });
  });

  it('an empty history has no rows and no times', () => {
    expect(collect([])).toEqual({
      firstAt: null,
      lastAt: null,
      days: [],
      hours: [],
      tools: [],
      agents: [],
    });
  });
});
