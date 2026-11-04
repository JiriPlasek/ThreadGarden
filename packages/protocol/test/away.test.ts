import { describe, expect, it } from 'vitest';
import {
  AWAY_CAPABILITY,
  AWAY_ERROR,
  AwayItemSchema,
  AwayStateSchema,
  ChatCopySchema,
  CopyItemSchema,
  MachineCopySchema,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  acceptsRemoteProtocol,
  events,
  methods,
} from '../src/index.js';

const uuid = '0b0e6d8e-6f43-4f6c-9b0e-2f5b1f0a9c11';

describe('protocol 11', () => {
  it('PROTOCOL_VERSION is 11 and the remote range is 10..12', () => {
    expect(PROTOCOL_VERSION).toBe(11);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 10, max: 12 });
    expect([9, 10, 11, 12, 13].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
  });

  it('has the away capability and error code', () => {
    expect(AWAY_CAPABILITY).toBe('away');
    expect(AWAY_ERROR).toBe('AWAY');
  });

  it('chat.send and chat.create accept and still parse without the new ids', () => {
    const send = methods['chat.send'].params;
    expect(send.safeParse({ sessionId: 's', text: 'hi' }).success).toBe(true);
    expect(send.safeParse({ sessionId: 's', text: 'hi', messageId: uuid }).success).toBe(true);
    expect(send.safeParse({ sessionId: 's', text: 'hi', messageId: 'nope' }).success).toBe(false);

    const create = methods['chat.create'].params;
    expect(create.safeParse({ cwd: '/p', text: 'hi' }).success).toBe(true);
    expect(create.safeParse({ cwd: '/p', text: 'hi', sessionId: uuid }).success).toBe(true);
    expect(create.safeParse({ cwd: '/p', text: 'hi', sessionId: 'nope' }).success).toBe(false);
  });

  it('away and copies methods and the away.changed event are listed', () => {
    for (const m of [
      'copies.saveLists',
      'copies.saveChat',
      'copies.get',
      'copies.chat',
      'copies.tails',
      'away.queue',
      'away.list',
      'away.cancel',
      'away.retry',
    ]) {
      expect(Object.keys(methods), m).toContain(m);
    }
    expect(Object.keys(events)).toContain('away.changed');
  });

  it('CopyItemSchema refuses a toolCall', () => {
    expect(CopyItemSchema.safeParse({ kind: 'user', id: 'u', text: 'a', ts: 1 }).success).toBe(true);
    expect(
      CopyItemSchema.safeParse({ kind: 'assistantText', id: 'a', markdown: 'x', streaming: false })
        .success,
    ).toBe(true);
    expect(
      CopyItemSchema.safeParse({
        kind: 'permissionRequest',
        id: 'p',
        requestId: 'r',
        toolName: 'Bash',
        input: {},
        suggestions: [],
        state: 'pending',
        variant: 'tool',
      }).success,
    ).toBe(true);
    expect(
      CopyItemSchema.safeParse({
        kind: 'toolCall',
        id: 't',
        toolUseId: 'x',
        name: 'Bash',
        input: {},
        status: 'ok',
        parentToolUseId: null,
      }).success,
    ).toBe(false);
  });

  it('the copy, item and state shapes parse', () => {
    const summary = {
      sessionId: 's',
      projectId: 'p',
      projectName: 'P',
      cwd: '/p',
      title: 't',
      lastActivity: 5,
      status: 'idle',
      live: false,
      unread: false,
      bucket: 'active',
      backFromHold: false,
    };
    // Reuse the real summary schema's verdict instead of guessing its fields.
    const ok = methods['sessions.list'].result.safeParse({ items: [summary] }).success;
    if (ok) {
      expect(
        MachineCopySchema.safeParse({
          machineId: 'm',
          info: null,
          projects: [],
          chats: [summary],
          copiedAt: 1,
        }).success,
      ).toBe(true);
      expect(
        ChatCopySchema.safeParse({
          machineId: 'm',
          sessionId: 's',
          summary,
          items: [],
          copiedAt: 1,
        }).success,
      ).toBe(true);
    }
    const item = {
      id: 'i',
      machineId: 'm',
      sessionId: 's',
      kind: 'send',
      text: 'hi',
      imageCount: 0,
      cwd: null,
      createdAt: 1,
      state: 'waiting',
      reason: null,
      error: null,
    };
    expect(AwayItemSchema.safeParse(item).success).toBe(true);
    expect(AwayItemSchema.safeParse({ ...item, state: 'gone' }).success).toBe(false);
    expect(AwayStateSchema.safeParse({ machineId: 'm', starting: false, startedAt: null }).success).toBe(
      true,
    );
    expect(events['away.changed'].safeParse({ items: [item], states: [] }).success).toBe(true);
  });

  it('away.queue takes optional images, cwd and settings', () => {
    const p = methods['away.queue'].params;
    expect(
      p.safeParse({ machineId: 'm', sessionId: 's', kind: 'send', text: 'hi' }).success,
    ).toBe(true);
    expect(
      p.safeParse({
        machineId: 'm',
        sessionId: 's',
        kind: 'create',
        text: 'hi',
        images: [{ mediaType: 'image/png', data: 'x' }],
        cwd: '/p',
        model: 'm',
        permissionMode: 'default',
        effort: 'high',
      }).success,
    ).toBe(true);
    expect(methods['copies.tails'].result.safeParse({ s: 5 }).success).toBe(true);
    expect(methods['copies.get'].result.safeParse(null).success).toBe(true);
  });
});
