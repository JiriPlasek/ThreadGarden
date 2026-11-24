/** Isolated title requests follow Codex's own temporary_structured_request.rs (v0.171). */
import type { OneShotOptions } from './adapter.js';
import { initializeCodex, type ConnectCodex } from './codex-client.js';
import { rec, str } from './codex-events.js';
import { codexModel } from './providers.js';

const disabledFeatures = [
  'apps',
  'code_mode',
  'code_mode_only',
  'context_management',
  'current_time_reminder',
  'deferred_executor',
  'enable_fanout',
  'goals',
  'hooks',
  'image_generation',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'standalone_web_search',
  'token_budget',
  'tool_suggest',
  'unified_exec',
  'view_image',
];

export const codexOneShot = async (
  options: OneShotOptions,
  connect: ConnectCodex,
  modelProvider?: string,
): Promise<string> => {
  options.signal.throwIfAborted();
  let threadId: string | undefined;
  let answer = '';
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // An exit or abort may arrive before initialization has finished.
  void completed.catch(() => {});
  const client = connect(
    options.env,
    (message) => {
      if (message.id !== undefined && message.method) {
        client.reject(message.id, 'Tools are disabled for title generation');
        reject(new Error('Codex requested a tool during title generation'));
        return;
      }
      const p = message.params ?? {};
      if (p.threadId && p.threadId !== threadId) return;
      if (message.method === 'item/completed' && rec(p.item).type === 'agentMessage')
        answer = str(rec(p.item).text);
      if (message.method === 'turn/completed') {
        if (rec(p.turn).status !== 'completed') reject(new Error('Codex title generation failed'));
        else resolve(answer);
      }
    },
    reject,
  );
  const abort = () => {
    reject(options.signal.reason);
    client.close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    await initializeCodex(client);
    const effective = await client.request('config/read', {
      includeLayers: false,
      cwd: options.cwd,
    });
    if (
      !effective.config ||
      typeof effective.config !== 'object' ||
      Array.isArray(effective.config)
    )
      throw new Error('Codex returned no effective configuration');
    const servers = Object.fromEntries(
      Object.keys(rec(rec(effective.config).mcp_servers)).map((name) => [name, { enabled: false }]),
    );
    const config = {
      ...Object.fromEntries(disabledFeatures.map((feature) => [`features.${feature}`, false])),
      'cloud.skills.enabled': false,
      'skills.include_instructions': false,
      'tools.experimental_request_user_input.enabled': false,
      'tools.update_plan.enabled': false,
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      mcp_servers: servers,
    };
    const result = await client.request('thread/start', {
      cwd: options.cwd,
      ...(codexModel(options.model) ? { model: codexModel(options.model) } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      baseInstructions: options.systemPrompt,
      developerInstructions: '',
      approvalPolicy: 'never',
      permissions: ':read-only',
      runtimeWorkspaceRoots: [],
      ephemeral: true,
      threadSource: 'thread_title',
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config,
    });
    if (rec(result.sandbox).type !== 'readOnly')
      throw new Error('Codex title thread did not start with read-only permissions');
    threadId = str(rec(result.thread).id);
    if (!threadId) throw new Error('Codex returned no title thread id');
    options.signal.throwIfAborted();
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.prompt, text_elements: [] }],
      permissions: ':read-only',
      runtimeWorkspaceRoots: [],
    });
    return await completed;
  } finally {
    options.signal.removeEventListener('abort', abort);
    client.close();
  }
};
