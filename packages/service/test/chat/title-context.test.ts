import type { ChatItem } from '@threadgarden/protocol';
import { expect, it } from 'vitest';
import { titleMessages } from '../../src/chat/title-context.js';

it('uses main conversation text without tools, child agents, internal notes or unfinished output', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'Inspect the repository', ts: 1 },
    { kind: 'assistantText', id: 'a1', markdown: 'What should we focus on?', streaming: false },
    {
      kind: 'user',
      id: 'note',
      text: '[Threadgarden] This chat moved from another machine',
      ts: 2,
    },
    { kind: 'user', id: 'control', text: '/compact', ts: 3 },
    { kind: 'thinking', id: 'thinking', text: 'Private intermediate work' },
    { kind: 'system', id: 'system', level: 'info', text: 'A skill was loaded' },
    {
      kind: 'assistantText',
      id: 'child',
      markdown: 'Unrelated child task',
      streaming: false,
      parentToolUseId: 'spawn',
    },
    { kind: 'user', id: 'child-user', text: 'Child prompt', ts: 4, parentToolUseId: 'spawn' },
    { kind: 'user', id: 'u2', text: '/home/me/src/login.ts has the redirect bug', ts: 5 },
    { kind: 'assistantText', id: 'unfinished', markdown: 'Half an answer', streaming: true },
    {
      kind: 'assistantText',
      id: 'answer',
      markdown: 'The callback drops the return URL.',
      streaming: false,
    },
  ];
  expect(titleMessages(items)).toEqual([
    { id: 'u1', role: 'user', text: 'Inspect the repository' },
    { id: 'a1', role: 'assistant', text: 'What should we focus on?' },
    { id: 'u2', role: 'user', text: '/home/me/src/login.ts has the redirect bug' },
    { id: 'answer', role: 'assistant', text: 'The callback drops the return URL.' },
  ]);
});

it('keeps substantive task commands but ignores empty image-only and control messages', () => {
  expect(
    titleMessages([
      { kind: 'user', id: 'review', text: '/review the login changes', ts: 1 },
      { kind: 'user', id: 'empty', text: '  ', ts: 2 },
      { kind: 'user', id: 'model', text: '/model opus', ts: 3 },
    ]),
  ).toEqual([{ id: 'review', role: 'user', text: '/review the login changes' }]);
});
