import { z } from 'zod';

/**
 * Where the Activity panel lists a task: subagents and background agents
 * (`agent`), background shells and monitors (`shell`), anything else
 * (`other`, with the SDK's raw `taskType` kept for display).
 */
export const ChatTaskKindSchema = z.enum(['agent', 'shell', 'other']);
export type ChatTaskKind = z.infer<typeof ChatTaskKindSchema>;

/** Task status; a value the SDK sends that pahub does not know is `unknown` with `rawStatus`. */
export const ChatTaskStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'stopped',
  'unknown',
]);
export type ChatTaskStatus = z.infer<typeof ChatTaskStatusSchema>;

/**
 * One SDK task (subagent, background shell, monitor, …) of a chat pahub runs,
 * folded from the SDK's `system/task_*` and `background_tasks_changed`
 * messages. Times are epoch milliseconds on the service clock; the UI derives
 * the live elapsed time from `startedAt` (and `endedAt` once it ended).
 */
export const ChatTaskSchema = z.object({
  taskId: z.string(),
  /** The `tool_use` that started the task (e.g. the Agent or Bash call), when known. */
  toolUseId: z.string().optional(),
  kind: ChatTaskKindSchema,
  /** The SDK's raw `task_type` (e.g. `local_agent`, `local_bash`), when known. */
  taskType: z.string().optional(),
  subagentType: z.string().optional(),
  description: z.string(),
  status: ChatTaskStatusSchema,
  /** The SDK's own status when `status` is `unknown`. */
  rawStatus: z.string().optional(),
  backgrounded: z.boolean().optional(),
  parentTaskId: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  tokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
  lastTool: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  /**
   * The agent's model, as given: the Agent call's `model` input (an alias such
   * as `sonnet`), else the model id its streamed messages report (v1.3 §2).
   */
  model: z.string().optional(),
  /** The prompt the agent was started with (`task_started.prompt`). */
  prompt: z.string().optional(),
  /** Nesting depth of a subagent: 1 when the main thread spawned it. */
  spawnDepth: z.number().optional(),
  /** The workflow script's name, for workflow tasks. */
  workflowName: z.string().optional(),
});
export type ChatTask = z.infer<typeof ChatTaskSchema>;
