import { describe, expect, it } from 'vitest';
import {
  ChatItemSchema,
  RequestSchema,
  events,
  methods,
  settingsDefaults,
  SettingsSchema,
  PROTOCOL_VERSION,
} from '../src/index.js';

const sampleItems = [
  { kind: 'user', id: 'a', text: 'hi', ts: 1, images: [{ mediaType: 'image/png', data: 'AA==' }] },
  { kind: 'assistantText', id: 'b', markdown: '# x', streaming: false },
  { kind: 'thinking', id: 'c', text: '...' },
  {
    kind: 'toolCall',
    id: 'd',
    toolUseId: 't1',
    name: 'Bash',
    input: { command: 'ls' },
    status: 'running',
    parentToolUseId: null,
  },
  { kind: 'todo', id: 'e', todos: [{ content: 'x', status: 'pending' }] },
  {
    kind: 'permissionRequest',
    id: 'f',
    requestId: 'r',
    toolName: 'Bash',
    input: {},
    suggestions: [],
    state: 'pending',
    variant: 'tool',
  },
  { kind: 'system', id: 'g', level: 'info', text: 'ok' },
  { kind: 'compactBoundary', id: 'h' },
  { kind: 'result', id: 'i', isError: false, durationMs: 5, costUsd: 0.1 },
  { kind: 'unknown', id: 'j', sdkType: 'weird', raw: { a: 1 } },
];

describe('protocol schemas', () => {
  it('exposes the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts every ChatItem kind', () => {
    for (const item of sampleItems) {
      expect(ChatItemSchema.safeParse(item).success, item.kind).toBe(true);
    }
  });

  it('keeps parentToolUseId on subagent items', () => {
    const item = {
      kind: 'assistantText',
      id: 'b',
      markdown: 'x',
      streaming: false,
      parentToolUseId: 't',
    };
    expect(ChatItemSchema.parse(item)).toEqual(item);
  });

  it('rejects a request without id', () => {
    expect(RequestSchema.safeParse({ method: 'hello', params: {} }).success).toBe(false);
    expect(RequestSchema.safeParse({ id: 1, method: 'hello', params: {} }).success).toBe(true);
  });

  it("parses an unknown future ChatItem kind as invalid (service must map to kind 'unknown' instead)", () => {
    expect(ChatItemSchema.safeParse({ kind: 'holo', id: 'x' }).success).toBe(false);
  });

  it('every method in the table has params and result schemas', () => {
    const expected = [
      'hello',
      'places.counts',
      'projects.list',
      'projects.update',
      'sessions.list',
      'sessions.summaries',
      'search.quick',
      'chat.open',
      'chat.older',
      'chat.since',
      'chat.create',
      'chat.send',
      'chat.interrupt',
      'chat.end',
      'chat.setModel',
      'chat.setPermissionMode',
      'chat.setEffort',
      'chat.respond',
      'chat.fork',
      'chat.resumeCheck',
      'chat.commands',
      'chat.models',
      'chat.resumeCommand',
      'files.suggest',
      'meta.update',
      'drafts.get',
      'drafts.set',
      'uiState.get',
      'uiState.set',
      'settings.get',
      'settings.set',
      'auth.setApiKey',
      'work.stopAll',
      'service.shutdown',
      'ui.visibility',
      'system.status',
    ];
    expect(Object.keys(methods).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      const m = methods[name as keyof typeof methods];
      expect(typeof m.params.safeParse, name).toBe('function');
      expect(typeof m.result.safeParse, name).toBe('function');
    }
  });

  it('defines every event', () => {
    expect(Object.keys(events).sort()).toEqual(
      [
        'chat.items',
        'chat.status',
        'sessions.changed',
        'projects.changed',
        'external.changed',
        'index.progress',
        'needsYou',
      ].sort(),
    );
  });

  it('Settings defaults match spec', () => {
    expect(settingsDefaults.idleReclaimMinutes).toBe(15);
    expect(settingsDefaults.startOnLogin).toBe(false);
    expect(settingsDefaults.notifications).toBe(true);
    expect(settingsDefaults.enterToSend).toBe(true);
    expect(settingsDefaults.externalPolling).toBe(true);
    expect(settingsDefaults.claudePath).toBeNull();
    expect(settingsDefaults.theme).toBe('system');
    expect(SettingsSchema.parse({})).toEqual(settingsDefaults);
  });
});
