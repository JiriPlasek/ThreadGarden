import { describe, expect, it } from 'vitest';
import {
  agentNameOf,
  isCodexChat,
  isCodexModel,
  modelsByRuntime,
  runtimeOfChat,
  runtimeOfModel,
} from '../../src/lib/runtime';

describe('runtime of a chat or model', () => {
  it('a codex- session id is a Codex chat, any other id is Claude’s', () => {
    expect(isCodexChat('codex-00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isCodexChat('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(runtimeOfChat('codex-x')).toBe('codex');
    expect(runtimeOfChat('s')).toBe('claude');
  });

  it('a codex: picker value is a Codex model; Default and others are Claude’s', () => {
    expect(isCodexModel('codex:gpt-5')).toBe(true);
    expect(isCodexModel('opus')).toBe(false);
    expect(isCodexModel('')).toBe(false);
    expect(isCodexModel(undefined)).toBe(false);
    expect(isCodexModel(null)).toBe(false);
    expect(runtimeOfModel('codex:default')).toBe('codex');
    expect(runtimeOfModel('')).toBe('claude');
  });

  it('names the agent after its runtime', () => {
    expect(agentNameOf('codex')).toBe('Codex');
    expect(agentNameOf('claude')).toBe('Claude');
  });

  it('splits picker values by runtime, keeping their order', () => {
    const models = [
      { value: 'opus' },
      { value: 'codex:b' },
      { value: 'sonnet' },
      { value: 'codex:a' },
    ];
    expect(modelsByRuntime(models)).toEqual({
      claude: [{ value: 'opus' }, { value: 'sonnet' }],
      codex: [{ value: 'codex:b' }, { value: 'codex:a' }],
    });
    expect(modelsByRuntime([{ value: 'opus' }]).codex).toEqual([]);
  });
});
