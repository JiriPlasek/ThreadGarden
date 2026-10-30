import { describe, expect, it } from 'vitest';
import {
  ChatItemSchema,
  ChatTaskSchema,
  ChatSummarySchema,
  ProjectSchema,
  RequestSchema,
  SettingsPatchSchema,
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
      'chat.stopTask',
      'external.stop',
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
      // v1.1 T2: "Your turn"
      'chat.markSeen',
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
        'chat.tasks',
        'sessions.changed',
        'projects.changed',
        'external.changed',
        'index.progress',
        'needsYou',
        // v1.1 T2: "Your turn"
        'chatFinished',
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

  it('ChatTask accepts a full agent row and a minimal unknown-status row', () => {
    const agent = {
      taskId: 'a1',
      toolUseId: 'toolu_1',
      kind: 'agent',
      taskType: 'local_agent',
      subagentType: 'general-purpose',
      description: 'Explore the project',
      status: 'running',
      backgrounded: false,
      parentTaskId: 'a0',
      startedAt: 1,
      endedAt: 2,
      tokens: 10,
      toolUses: 2,
      durationMs: 1000,
      lastTool: 'Read',
      summary: 'Reading files',
      error: 'boom',
    };
    expect(ChatTaskSchema.parse(agent)).toEqual(agent);
    const odd = {
      taskId: 'x',
      kind: 'other',
      description: 'something new',
      status: 'unknown',
      rawStatus: 'hibernating',
      startedAt: 5,
    };
    expect(ChatTaskSchema.parse(odd)).toEqual(odd);
    expect(ChatTaskSchema.safeParse({ ...odd, status: 'hibernating' }).success).toBe(false);
    expect(ChatTaskSchema.safeParse({ ...odd, kind: 'robot' }).success).toBe(false);
  });

  it('chat.tasks events are replayable through chat.since and listed by chat.open', () => {
    const tasks = [
      { taskId: 'b1', kind: 'shell', description: 'npm run dev', status: 'running', startedAt: 1 },
    ];
    const event = { sessionId: 's', seq: 3, tasks };
    expect(events['chat.tasks'].parse(event)).toEqual(event);
    const since = methods['chat.since'].result.parse({ events: [event], seq: 3 });
    expect(since.events[0]).toEqual(event);
    const opened = methods['chat.open'].result.safeParse({
      summary: {
        sessionId: 's',
        title: 't',
        projectId: 'p',
        cwd: '/',
        status: 'idle',
        preview: '',
        lastActivity: 0,
        pinned: false,
        live: true,
        external: null,
      },
      header: {},
      items: [],
      hasMore: false,
      seq: 3,
      tasks,
    });
    expect(opened.success).toBe(true);
    expect(methods['chat.stopTask'].params.parse({ sessionId: 's', taskId: 'b1' })).toEqual({
      sessionId: 's',
      taskId: 'b1',
    });
    expect(methods['chat.stopTask'].result.parse({})).toEqual({});
  });

  // ── v1.1 T2: "Your turn", project order, missing folders ──────────────────

  it('notifyOnFinish defaults to true and is patchable on its own', () => {
    expect(settingsDefaults.notifyOnFinish).toBe(true);
    expect(SettingsPatchSchema.parse({ notifyOnFinish: false })).toEqual({ notifyOnFinish: false });
    expect(SettingsPatchSchema.parse({})).toEqual({});
    expect(SettingsPatchSchema.safeParse({ notifyOnFinish: 'no' }).success).toBe(false);
  });

  it('ChatSummary.unread defaults to false; Project.exists defaults to true', () => {
    const summary = {
      sessionId: 's',
      title: 't',
      projectId: 'p',
      cwd: '/w',
      status: 'idle',
      preview: '',
      lastActivity: 1,
      pinned: false,
      live: true,
      external: null,
    };
    expect(ChatSummarySchema.parse(summary).unread).toBe(false);
    expect(ChatSummarySchema.parse({ ...summary, unread: true }).unread).toBe(true);
    // Ruling R29: a live chat's running background tasks (absent when none).
    expect(ChatSummarySchema.parse(summary)).not.toHaveProperty('runningTasks');
    expect(ChatSummarySchema.parse({ ...summary, runningTasks: 2 }).runningTasks).toBe(2);
    expect(ChatSummarySchema.safeParse({ ...summary, runningTasks: -1 }).success).toBe(false);
    expect(ChatSummarySchema.safeParse({ ...summary, runningTasks: 1.5 }).success).toBe(false);
    const project = {
      projectId: 'p',
      path: '/w',
      displayName: 'w',
      pinned: false,
      hidden: false,
      lastActivity: 1,
      counts: { needsYou: 0, running: 0 },
    };
    expect(ProjectSchema.parse(project).exists).toBe(true);
    expect(ProjectSchema.parse({ ...project, exists: false }).exists).toBe(false);
  });

  it('chat.markSeen takes a session id; chatFinished names the chat', () => {
    expect(methods['chat.markSeen'].params.safeParse({ sessionId: 's' }).success).toBe(true);
    expect(methods['chat.markSeen'].params.safeParse({}).success).toBe(false);
    expect(methods['chat.markSeen'].result.safeParse({}).success).toBe(true);
    const finished = { sessionId: 's', title: 'Fix the build', projectName: 'pahub' };
    expect(events.chatFinished.parse(finished)).toEqual(finished);
    expect(events.chatFinished.safeParse({ sessionId: 's' }).success).toBe(false);
  });
});
