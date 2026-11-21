/** Codex wire items translated once for live output and imported history. */
import type { SDKMessage, SessionMessage } from './adapter.js';

export type Rec = Record<string, unknown>;
export const rec = (value: unknown): Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : {};
export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
export const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const millis = (value: unknown): number => {
  const n = finite(value);
  return n === undefined ? 0 : n < 1e11 ? n * 1000 : n;
};
export const envelope = (
  sessionId: string,
  uuid: string,
  message: Rec,
  timestamp?: number,
): SDKMessage =>
  ({
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...(timestamp ? { timestamp: new Date(timestamp).toISOString() } : {}),
    ...message,
  }) as unknown as SDKMessage;

export const itemMessages = (
  sessionId: string,
  item: Rec,
  model: string | undefined,
  completed = true,
  at = 0,
): SDKMessage[] => {
  const id = str(item.id);
  if (!id) return [];
  const start = finite(item.startedAtMs) ?? at;
  const end = finite(item.completedAtMs) ?? start;
  const assistant = (content: Rec[]): SDKMessage =>
    envelope(
      sessionId,
      id,
      { type: 'assistant', message: { id, role: 'assistant', model, content } },
      end,
    );
  switch (item.type) {
    case 'userMessage': {
      if (!completed) return [];
      const content = (Array.isArray(item.content) ? item.content : []).flatMap((value): Rec[] => {
        const block = rec(value);
        if (block.type === 'text') return [{ type: 'text', text: str(block.text) }];
        if (block.type === 'image') {
          const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(str(block.url));
          if (match)
            return [
              { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
            ];
          return [{ type: 'text', text: '[Image attachment]' }];
        }
        if (block.type === 'localImage')
          return [{ type: 'text', text: `[Image: ${str(block.path)}]` }];
        if (block.type === 'mention' || block.type === 'skill')
          return [{ type: 'text', text: `${str(block.name)} (${str(block.path)})` }];
        return [];
      });
      return [
        envelope(
          sessionId,
          str(item.clientId) || id,
          { type: 'user', message: { role: 'user', content } },
          start,
        ),
      ];
    }
    case 'agentMessage':
    case 'plan':
      return completed ? [assistant([{ type: 'text', text: str(item.text) }])] : [];
    case 'reasoning': {
      const summary = (Array.isArray(item.summary) ? item.summary : []).map(str).join('\n');
      return completed && summary ? [assistant([{ type: 'thinking', thinking: summary }])] : [];
    }
    case 'contextCompaction':
      return completed
        ? [envelope(sessionId, id, { type: 'system', subtype: 'compact_boundary' }, end)]
        : [];
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'webSearch':
    case 'collabAgentToolCall':
    case 'dynamicToolCall':
    case 'imageView': {
      const name =
        item.type === 'commandExecution'
          ? 'Bash'
          : item.type === 'fileChange'
            ? 'CodexPatch'
            : item.type === 'mcpToolCall'
              ? `mcp__${str(item.server)}__${str(item.tool)}`
              : str(item.type);
      const call = envelope(
        sessionId,
        id,
        {
          type: 'assistant',
          message: {
            id,
            role: 'assistant',
            model,
            content: [{ type: 'tool_use', id, name, input: item }],
          },
        },
        start,
      );
      if (!completed) return [call];
      const output =
        str(item.aggregatedOutput) || JSON.stringify(item.result ?? item.changes ?? item);
      return [
        call,
        envelope(
          sessionId,
          `${id}-result`,
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content: output,
                  is_error:
                    item.status === 'failed' || item.status === 'declined' || item.error != null,
                },
              ],
            },
          },
          end,
        ),
      ];
    }
    default:
      return completed ? [envelope(sessionId, id, { type: 'codex_item', item }, end)] : [];
  }
};

export const turnMessages = (sessionId: string, turn: Rec, model?: string): SessionMessage[] => {
  const at = millis(turn.startedAt);
  const items: SDKMessage[] = (Array.isArray(turn.items) ? turn.items : []).flatMap((item) =>
    itemMessages(sessionId, rec(item), model, true, at).map((message) => ({
      ...message,
      codex_turn_id: str(turn.id),
    })),
  );
  if (turn.status !== 'inProgress') {
    const failed = turn.status === 'failed';
    if (failed)
      items.push(
        envelope(
          sessionId,
          `${str(turn.id)}-error`,
          {
            type: 'assistant',
            message: {
              id: `${str(turn.id)}-error`,
              role: 'assistant',
              model: '<synthetic>',
              content: [
                { type: 'text', text: str(rec(turn.error).message) || 'Codex turn failed' },
              ],
            },
          },
          millis(turn.completedAt) || at,
        ),
      );
    items.push(
      envelope(
        sessionId,
        `${str(turn.id)}-result`,
        {
          type: 'result',
          subtype: failed ? 'error_during_execution' : 'success',
          is_error: failed,
          ...(finite(turn.durationMs) !== undefined ? { duration_ms: turn.durationMs } : {}),
        },
        millis(turn.completedAt) || at,
      ),
    );
  }
  return items as unknown as SessionMessage[];
};
