import { describe, expect, it } from 'vitest';
import type { CanUseTool, OneShotOptions, StartOptions } from '../../src/sdk/adapter.js';
import {
  buildOneShotOptions,
  buildQueryOptions,
  buildSessionEnv,
} from '../../src/sdk/real-adapter.js';

const canUseTool: CanUseTool = async () => ({ behavior: 'allow' });

const start = (over: Partial<StartOptions> = {}): StartOptions => ({
  cwd: '/work/proj',
  env: { PATH: '/usr/bin', HOME: '/home/u' },
  claudePath: '/home/u/.local/bin/claude',
  canUseTool,
  ...over,
});

describe('buildQueryOptions', () => {
  it('buildQueryOptions sets preset system prompt, settingSources user/project/local, includePartialMessages, pathToClaudeCodeExecutable', () => {
    const o = buildQueryOptions(start());
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.includePartialMessages).toBe(true);
    expect(o.pathToClaudeCodeExecutable).toBe('/home/u/.local/bin/claude');
    expect(o.cwd).toBe('/work/proj');
    expect(o.canUseTool).toBe(canUseTool);
  });

  it('buildQueryOptions never sets clientComposed', () => {
    const o = buildQueryOptions(
      start({ model: 'opus', effort: 'high', permissionMode: 'plan', sessionId: 'x' }),
    ) as Record<string, unknown>;
    expect(o).not.toHaveProperty('clientComposed');
    expect(o).not.toHaveProperty('client_composed');
    // The SDK 0.3.314 name of the same switch.
    expect(o).not.toHaveProperty('verbatimPrompts');
  });

  it('sets exactly the documented keys and nothing else', () => {
    const o = buildQueryOptions(start());
    expect(Object.keys(o).sort()).toEqual(
      [
        'canUseTool',
        'cwd',
        'env',
        'includePartialMessages',
        'pathToClaudeCodeExecutable',
        'perTaskStopAffordance',
        'settingSources',
        'systemPrompt',
      ].sort(),
    );
  });

  it('declares the per-task stop affordance, so Stop / Esc on a turn spares background tasks', () => {
    // SDK 0.3.314 Options.perTaskStopAffordance: without it, an interrupt on an
    // open-input session kills every background task (the CLI fails closed).
    expect(buildQueryOptions(start()).perTaskStopAffordance).toBe(true);
    expect(buildQueryOptions(start({ resume: 'abc' })).perTaskStopAffordance).toBe(true);
  });

  it('passes model, effort and permission mode only when chosen', () => {
    const o = buildQueryOptions(
      start({ model: 'claude-opus-5-5', effort: 'max', permissionMode: 'acceptEdits' }),
    );
    expect(o).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'max',
      permissionMode: 'acceptEdits',
    });
    const bare = buildQueryOptions(start());
    expect(bare).not.toHaveProperty('model');
    expect(bare).not.toHaveProperty('effort');
    expect(bare).not.toHaveProperty('permissionMode');
  });

  it('forwards the pre-generated session id for a new chat', () => {
    const o = buildQueryOptions(start({ sessionId: '6f1c0e8e-1111-4222-8333-944455556666' }));
    expect(o.sessionId).toBe('6f1c0e8e-1111-4222-8333-944455556666');
    expect(o).not.toHaveProperty('resume');
  });

  it('uses resume alone when resuming (the SDK rejects sessionId with resume)', () => {
    const o = buildQueryOptions(start({ resume: 'abc', sessionId: 'abc' }));
    expect(o.resume).toBe('abc');
    expect(o).not.toHaveProperty('sessionId');
    expect(o).not.toHaveProperty('forkSession');
  });

  it('passes the session env and asks the CLI to report startup failures as results', () => {
    const o = buildQueryOptions(start({ env: { PATH: '/x', ANTHROPIC_API_KEY: 'k' } }));
    expect(o.env).toEqual({
      PATH: '/x',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
    });
  });
});

describe('buildSessionEnv', () => {
  it('buildSessionEnv keeps PATH and sets ANTHROPIC_API_KEY only when given', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/u', LANG: 'C' };
    const inherit = buildSessionEnv(base, null);
    expect(inherit).toEqual(base);
    expect(inherit).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(inherit).not.toBe(base);

    const keyed = buildSessionEnv(base, 'sk-test');
    expect(keyed).toEqual({ ...base, ANTHROPIC_API_KEY: 'sk-test' });
    expect(base).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('keeps an inherited ANTHROPIC_API_KEY when Threadgarden has no key of its own', () => {
    expect(buildSessionEnv({ ANTHROPIC_API_KEY: 'from-shell' }, null)).toEqual({
      ANTHROPIC_API_KEY: 'from-shell',
    });
    expect(buildSessionEnv({ ANTHROPIC_API_KEY: 'from-shell' }, 'pahub')).toEqual({
      ANTHROPIC_API_KEY: 'pahub',
    });
  });
});

// ── v1.2 C1: chat titles ──

describe('buildOneShotOptions (title generation)', () => {
  const oneShot: OneShotOptions = {
    prompt: 'Title this conversation',
    systemPrompt: 'Reply with only a title',
    model: 'haiku',
    cwd: '/work/proj',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' },
    claudePath: '/home/u/.local/bin/claude',
    signal: new AbortController().signal,
    sessionId: '0b0e8f6a-1111-4222-8333-944455556666',
  };

  it('never persists a transcript, loads no settings and allows no tools, for one turn', () => {
    const ac = new AbortController();
    const o = buildOneShotOptions(oneShot, ac);
    // SDK 0.3.314 Options.persistSession: false: nothing saved under ~/.claude/projects.
    expect(o.persistSession).toBe(false);
    // settingSources: [] is the SDK isolation mode (no settings, hooks or CLAUDE.md).
    expect(o.settingSources).toEqual([]);
    // tools: [] disables every built-in tool; strictMcpConfig without mcpServers: no MCP tools.
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o).not.toHaveProperty('mcpServers');
    expect(o).not.toHaveProperty('allowedTools');
    expect(o.maxTurns).toBe(1);
    expect(o.model).toBe('haiku');
    expect(o.systemPrompt).toBe('Reply with only a title');
    expect(o.thinking).toEqual({ type: 'disabled' });
    expect(o.abortController).toBe(ac);
  });

  it('runs under the known session id Threadgarden gave it (so the external poller can leave it out)', () => {
    const o = buildOneShotOptions(oneShot, new AbortController());
    expect(o.sessionId).toBe('0b0e8f6a-1111-4222-8333-944455556666');
    expect(o).not.toHaveProperty('resume');
  });

  it("runs like the user's sessions: same claude, environment (API key included) and folder", () => {
    const o = buildOneShotOptions(oneShot, new AbortController());
    expect(o.pathToClaudeCodeExecutable).toBe('/home/u/.local/bin/claude');
    expect(o.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' });
    expect(o.cwd).toBe('/work/proj');
  });

  it('sets exactly the documented keys and nothing else', () => {
    const o = buildOneShotOptions(oneShot, new AbortController());
    expect(Object.keys(o).sort()).toEqual(
      [
        'abortController',
        'cwd',
        'env',
        'maxTurns',
        'model',
        'pathToClaudeCodeExecutable',
        'persistSession',
        'sessionId',
        'settingSources',
        'strictMcpConfig',
        'systemPrompt',
        'thinking',
        'tools',
      ].sort(),
    );
  });
});
