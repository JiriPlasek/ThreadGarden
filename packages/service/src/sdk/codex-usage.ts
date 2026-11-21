import { finite, rec, str, type Rec } from './codex-events.js';

/** Normalize Codex's native account limits without mixing them with Anthropic's. */
export const codexUsage = (response: Rec, accountResponse: Rec): Rec => {
  const account = rec(accountResponse.account);
  if (account.type !== 'chatgpt')
    return {
      rate_limits_available: false,
      rate_limits: {},
      account: { kind: account.type === 'apiKey' ? 'apiKey' : 'provider', runtime: 'codex' },
    };
  const limits: Rec = {};
  const byId = rec(response.rateLimitsByLimitId);
  const buckets = Object.keys(byId).length
    ? Object.entries(byId)
    : [['codex', response.rateLimits] as [string, unknown]];
  for (const [id, value] of buckets) {
    const bucket = rec(value);
    for (const slot of ['primary', 'secondary']) {
      const window = rec(bucket[slot]);
      const used = finite(window.usedPercent);
      if (used === undefined) continue;
      const minutes = finite(window.windowDurationMins);
      const key =
        id === 'codex' && minutes === 300
          ? 'five_hour'
          : id === 'codex' && minutes === 10080
            ? 'seven_day'
            : `codex:${id}:${slot}`;
      const refused =
        (id === 'codex' && response.ordinaryUsageAllowed === false) ||
        bucket.rateLimitReachedType != null;
      limits[key] = {
        utilization: used,
        resets_at: window.resetsAt,
        label: key.startsWith('codex:')
          ? `${str(bucket.limitName) || id} · ${minutes ? `${minutes} min` : slot}`
          : undefined,
        status: refused ? 'rejected' : used >= 90 ? 'allowed_warning' : 'allowed',
      };
    }
  }
  return {
    rate_limits_available: true,
    subscription_type: str(account.planType) || undefined,
    rate_limits: limits,
    account: {
      kind: 'login',
      runtime: 'codex',
      ...(str(account.email) ? { email: str(account.email) } : {}),
      ...(str(account.planType) ? { plan: str(account.planType) } : {}),
    },
  };
};

export const codexTokens = (value: unknown): Rec | undefined => {
  const usage = rec(value);
  const input = finite(usage.inputTokens);
  const output = finite(usage.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  const cached = finite(usage.cachedInputTokens) ?? 0;
  const written = finite(usage.cacheWriteInputTokens) ?? 0;
  return {
    input_tokens: Math.max(0, (input ?? 0) - cached - written),
    output_tokens: output ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
};
