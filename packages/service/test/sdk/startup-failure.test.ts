import { describe, expect, it } from 'vitest';
import type { SDKStartupFailureReason } from '@anthropic-ai/claude-agent-sdk';
import { startupFailureMessage } from '../../src/sdk/startup-failure.js';

// Copied from `SDKStartupFailureReason` in @anthropic-ai/claude-agent-sdk 0.3.314.
const ALL = [
  'org_pin_api_key_conflict',
  'provider_not_allowed',
  'org_verify_failed',
  'org_pin_mismatch',
  'managed_settings_invalid',
  'remote_settings_required_unavailable',
  'gateway_signin_required',
  'gateway_access_denied',
  'proxy_invalid',
  'temp_dir_unusable',
  'cwd_unavailable',
  'shell_tool_missing',
  'session_held_by_background',
  'worktree_resume_refused',
  'worktree_unverified',
  'cli_version_too_old',
  'bypass_root',
  'org_config_required_unavailable',
  'org_config_refused',
  'sandbox_required_unavailable',
] as const satisfies readonly SDKStartupFailureReason[];

// Fails to compile when the SDK adds a reason this list (and so the test) misses.
type Missing = Exclude<SDKStartupFailureReason, (typeof ALL)[number]>;
const exhaustive: [Missing] extends [never] ? true : false = true;

describe('startupFailureMessage', () => {
  it('maps every SDKStartupFailureReason to a user message', () => {
    expect(exhaustive).toBe(true);
    const generic = startupFailureMessage('__not_a_reason__');
    for (const reason of ALL) {
      const m = startupFailureMessage(reason);
      expect(m.title, reason).not.toBe(generic.title);
      expect(m.title.length, reason).toBeGreaterThan(0);
      expect(m.body.length, reason).toBeGreaterThan(20);
      expect(m.body, reason).not.toContain(reason);
      expect(m.setup, reason).toBe(reason === 'cli_version_too_old');
    }
  });

  it('gives distinct titles or bodies per reason', () => {
    const texts = new Set(ALL.map((r) => JSON.stringify(startupFailureMessage(r))));
    expect(texts.size).toBe(ALL.length);
  });

  it('uses a generic message containing the raw reason for unknown reasons', () => {
    const m = startupFailureMessage('brand_new_reason');
    expect(m.setup).toBe(false);
    expect(`${m.title} ${m.body}`).toContain('brand_new_reason');
  });

  it('does not treat inherited object keys as known reasons', () => {
    expect(startupFailureMessage('toString').body).toContain('toString');
  });
});
