import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CLAUDE_LOGIN_CAPABILITY,
  CLAUDE_LOGIN_ERRORS,
  ClaudeAccountSchema,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  events,
  methods,
} from '../src/index.js';

const CLAUDE_METHODS = ['claude.account', 'claude.signIn', 'claude.signInCode', 'claude.signInCancel'] as const;

describe('protocol 14', () => {
  it('PROTOCOL_VERSION is 14 and the remote range is 13..15', () => {
    expect(PROTOCOL_VERSION).toBe(14);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 13, max: 15 });
  });

  it("CLAUDE_LOGIN_CAPABILITY is 'claude-login' and not in CAPABILITIES", () => {
    expect(CLAUDE_LOGIN_CAPABILITY).toBe('claude-login');
    expect(CAPABILITIES).not.toContain('claude-login');
    expect(Object.values(CLAUDE_LOGIN_ERRORS)).toEqual(['LOGIN_FAILED', 'LOGIN_NOT_STARTED', 'LOGIN_UNSUPPORTED']);
  });

  it('claude.* methods and the claude.account event are listed', () => {
    for (const m of CLAUDE_METHODS) {
      expect(Object.keys(methods), m).toContain(m);
      expect((methods as Record<string, { localOnly?: boolean }>)[m]?.localOnly, m).toBeFalsy();
    }
    expect(Object.keys(events)).toContain('claude.account');
    expect(ClaudeAccountSchema.safeParse({ account: null, expired: false, signingIn: false }).success).toBe(true);
    expect(ClaudeAccountSchema.safeParse({ expired: false, signingIn: false }).success).toBe(false);
  });

  it('claude.signInCode refuses an empty code', () => {
    const params = methods['claude.signInCode'].params;
    expect(params.safeParse({ code: '' }).success).toBe(false);
    expect(params.safeParse({ code: 'abc' }).success).toBe(true);
    expect(params.safeParse({ code: 'x'.repeat(4097) }).success).toBe(false);
  });
});
