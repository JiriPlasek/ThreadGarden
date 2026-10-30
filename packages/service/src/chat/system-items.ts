/**
 * Classification of the SDK 0.3.314 message types that are neither chat
 * content blocks nor `result` (Ruling R7). Types declared in the SDK's
 * `SDKMessage` union are either non-visual (no chat item; status, header and
 * task views consume them elsewhere) or mapped to a readable `system` line.
 * Only types outside that union, or malformed shapes, become `unknown`.
 */
type Rec = Record<string, unknown>;
type Level = 'info' | 'warning' | 'error';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const nonEmpty = (v: unknown): string | undefined => {
  const s = str(v)?.trim();
  return s ? s : undefined;
};

/** Top-level `type`s that never render in the chat. */
export const NON_VISUAL_TYPES: ReadonlySet<string> = new Set([
  'tool_progress',
  'rate_limit_event',
  'tool_use_summary',
  'prompt_suggestion',
  'auth_status',
]);

/** `type: 'system'` subtypes that never render in the chat. */
export const NON_VISUAL_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'init',
  'session_state_changed',
  'commands_changed',
  'status',
  'thinking_tokens',
  'hook_started',
  'hook_progress',
  'task_started',
  'task_updated',
  'task_progress',
  'background_tasks_changed',
  'control_request_progress',
  'files_persisted',
  'memory_recall',
  'worker_shutting_down',
  'plugin_install',
  'elicitation_complete',
]);

export type SystemLine = { level: Level; text: string };

/**
 * Readable line for a content-bearing system subtype; `null` when this
 * instance has nothing user-visible (e.g. a silent successful hook);
 * `undefined` when the subtype is not one we know (caller maps to `unknown`).
 */
export const systemLine = (subtype: string, m: Rec): SystemLine | null | undefined => {
  switch (subtype) {
    case 'api_retry': {
      const status = num(m.error_status);
      const delay = num(m.retry_delay_ms) ?? 0;
      return {
        level: 'warning',
        text:
          `API error${status === undefined ? '' : ` (${status})`}, ` +
          `retrying in ${Math.round(delay / 1000)} s ` +
          `(attempt ${num(m.attempt) ?? '?'} of ${num(m.max_retries) ?? '?'})`,
      };
    }
    case 'informational':
      return { level: m.level === 'warning' ? 'warning' : 'info', text: str(m.content) ?? '' };
    case 'notification':
      return { level: 'info', text: str(m.text) ?? '' };
    case 'local_command_output':
      return { level: 'info', text: str(m.content) ?? '' };
    case 'permission_denied': {
      const reason = nonEmpty(m.decision_reason);
      const message = nonEmpty(m.message);
      return {
        level: 'warning',
        text:
          `Permission denied: ${str(m.tool_name) ?? 'tool'}` +
          (message ? ` — ${message}` : '') +
          (reason && reason !== message ? ` (${reason})` : ''),
      };
    }
    case 'task_notification': {
      if (m.skip_transcript === true) return null;
      const status = str(m.status) ?? 'finished';
      const summary = nonEmpty(m.summary);
      return {
        level: status === 'failed' ? 'error' : status === 'stopped' ? 'warning' : 'info',
        text: `Task ${status}${summary ? `: ${summary}` : ''}`,
      };
    }
    case 'hook_response': {
      const name = str(m.hook_name) ?? str(m.hook_event) ?? 'hook';
      if (m.outcome === 'error') {
        const detail = nonEmpty(m.stderr) ?? nonEmpty(m.output);
        const code = num(m.exit_code);
        return {
          level: 'warning',
          text:
            `Hook ${name} failed` +
            (detail ? `: ${detail}` : code === undefined ? '' : ` (exit code ${code})`),
        };
      }
      const output = m.outcome === 'success' ? nonEmpty(m.output) : undefined;
      return output ? { level: 'info', text: `Hook ${name}: ${output}` } : null;
    }
    case 'model_refusal_fallback':
      return {
        level: 'warning',
        text: str(m.content) ?? 'The model refused; retried on fallback.',
      };
    case 'model_refusal_no_fallback':
      return { level: 'error', text: str(m.content) ?? 'The model refused to respond.' };
    case 'mirror_error':
      return { level: 'warning', text: `Transcript mirror error: ${str(m.error) ?? 'unknown'}` };
    default:
      return undefined;
  }
};

export const conversationResetText = (m: Rec): string =>
  m.trigger === undefined || m.trigger === 'clear'
    ? 'Conversation cleared'
    : `Conversation reset (${String(m.trigger)})`;
