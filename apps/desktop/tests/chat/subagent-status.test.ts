import type { ChatTask } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import { agentRowStatus } from '../../src/lib/components/chat/activity';
import { tool } from './fixtures';

const LAUNCHED =
  'Async agent launched successfully.\nagentId: a1 (internal ID)\nThe agent is working in the background.';

const call = (over: Parameters<typeof tool>[3] = {}, input: Record<string, unknown> = {}) =>
  tool('c1', 'Agent', { description: 'Map the pages', prompt: 'go', ...input }, over);

const task = (over: Partial<ChatTask> = {}): ChatTask => ({
  taskId: 'a1',
  toolUseId: 'tu-c1',
  kind: 'agent',
  description: 'Map the pages',
  status: 'running',
  startedAt: 1_000,
  ...over,
});

describe('agentRowStatus', () => {
  it('a background agent whose call returned is Running while its task runs', () => {
    const s = agentRowStatus(call({ status: 'ok', resultText: LAUNCHED }), task());
    expect(s).toEqual({ icon: 'running', text: 'Running', since: 1_000 });
  });

  it('a pending or not-yet-ended unknown task counts as running', () => {
    expect(agentRowStatus(call(), task({ status: 'pending' })).icon).toBe('running');
    expect(agentRowStatus(call(), task({ status: 'unknown', rawStatus: 'x' })).icon).toBe(
      'running',
    );
  });

  it('follows the task to its end', () => {
    const done = call({ status: 'ok', resultText: LAUNCHED });
    expect(agentRowStatus(done, task({ status: 'completed', endedAt: 9 }))).toEqual({
      icon: 'ok',
      text: 'Done',
    });
    expect(agentRowStatus(done, task({ status: 'failed', endedAt: 9 }))).toEqual({
      icon: 'error',
      text: 'Failed',
    });
    expect(agentRowStatus(done, task({ status: 'stopped', endedAt: 9 }))).toEqual({
      icon: 'idle',
      text: 'Stopped',
    });
    expect(agentRowStatus(done, task({ status: 'paused' }))).toEqual({
      icon: 'idle',
      text: 'Paused',
    });
  });

  it('without a task, a running call is Running and a failed one Failed', () => {
    expect(agentRowStatus(call({ status: 'running' }), undefined)).toEqual({
      icon: 'running',
      text: 'Running',
    });
    expect(agentRowStatus(call({ status: 'error' }), undefined)).toEqual({
      icon: 'error',
      text: 'Failed',
    });
  });

  it('without a task, a background launch never claims Done', () => {
    expect(agentRowStatus(call({ status: 'ok', resultText: LAUNCHED }), undefined)).toEqual({
      icon: 'idle',
      text: 'Started in background',
    });
    expect(
      agentRowStatus(
        call({ status: 'ok', resultText: 'ok' }, { run_in_background: true }),
        undefined,
      ),
    ).toEqual({ icon: 'idle', text: 'Started in background' });
  });

  it('without a task, a foreground call that returned is Done', () => {
    expect(
      agentRowStatus(call({ status: 'ok', resultText: 'Found 12 pages.' }), undefined),
    ).toEqual({ icon: 'ok', text: 'Done' });
  });
});
