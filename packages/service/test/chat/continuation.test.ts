import { expect, it } from 'vitest';
import { continuationTranscript } from '../../src/chat/continuation.js';

it('exports readable exchanges, tool results and child context without thinking or opaque records', () => {
  const text = continuationTranscript(
    { sessionId: 'source', title: 'Repair login', cwd: '/work/app' },
    [
      {
        kind: 'user',
        id: 'u',
        text: 'Fix the login redirect',
        ts: 1000,
        images: [{ mediaType: 'image/png', data: 'PRIVATE_IMAGE_DATA', number: 1 }],
      },
      { kind: 'thinking', id: 'r', text: 'PRIVATE_THINKING' },
      { kind: 'assistantText', id: 'a', markdown: 'Found a missing returnUrl', streaming: false },
      {
        kind: 'toolCall',
        id: 't',
        toolUseId: 'tool',
        name: 'Bash',
        input: { command: 'pnpm test' },
        status: 'error',
        resultText: 'Safari test failed',
        parentToolUseId: null,
      },
      {
        kind: 'assistantText',
        id: 'child',
        markdown: 'Cookie path needs fixing',
        streaming: false,
        parentToolUseId: 'agent-1',
      },
      { kind: 'unknown', id: 'opaque', sdkType: 'opaque', raw: { secret: 'RAW_RECORD' } },
    ],
  );
  expect(text).toContain('Repair login');
  expect(text).toContain('Fix the login redirect');
  expect(text).toContain('Found a missing returnUrl');
  expect(text).toContain('pnpm test');
  expect(text).toContain('Safari test failed');
  expect(text).toContain('Subagent agent-1');
  expect(text).toContain('Cookie path needs fixing');
  expect(text).toContain('Image #1');
  expect(text).toContain('not copied');
  expect(text).not.toContain('PRIVATE_IMAGE_DATA');
  expect(text).not.toContain('PRIVATE_THINKING');
  expect(text).not.toContain('RAW_RECORD');
});
