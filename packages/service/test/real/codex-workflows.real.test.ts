/** Real CLI workflows, deliberately bounded to disposable folders and harmless commands. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveSession } from '../../src/chat/live-session.js';
import type { PermissionMode } from '../../src/sdk/adapter.js';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import {
  connectCodex,
  type CodexConnection,
  type ConnectCodex,
  type RpcMessage,
} from '../../src/sdk/codex-client.js';
import { rec, str, type Rec } from '../../src/sdk/codex-events.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { MemoryRegistry } from '../chat/live-helpers.js';

const enabled = process.env.THREADGARDEN_TEST_CODEX_INFERENCE === '1';
const roots: string[] = [];
const sessions: LiveSession[] = [];
const adapters: MultiAdapter[] = [];
const diagnostics: {
  root: string;
  events: RpcMessage[];
  calls: { method: string; params: Rec; result?: Rec; error?: string }[];
}[] = [];
afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    const dir = new URL('../../dist/codex-real-failures/', import.meta.url);
    await mkdir(dir, { recursive: true });
    for (const h of diagnostics)
      await writeFile(
        new URL(`${path.basename(h.root)}.json`, dir),
        JSON.stringify(
          {
            name: context.task.name,
            events: h.events.filter(
              (event) =>
                ['item/completed', 'turn/completed', 'error'].includes(event.method ?? '') ||
                event.id !== undefined,
            ),
            calls: h.calls.filter((call) => /thread\/start|turn\/start/.test(call.method)),
          },
          null,
          2,
        ),
      );
  }
  diagnostics.splice(0);
  for (const session of sessions.splice(0)) {
    session.end();
    await session.whenEnded();
  }
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const eventually = async (
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 90_000,
): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tg-codex-workflows-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await Promise.all([mkdir(cwd), mkdir(outside)]);
  const events: RpcMessage[] = [];
  const calls: { method: string; params: Rec; result?: Rec; error?: string }[] = [];
  diagnostics.push({ root, events, calls });
  let client: CodexConnection;
  const connect: ConnectCodex = (env, onMessage, onExit) => {
    const real = connectCodex(
      env,
      (message) => {
        events.push(message);
        onMessage(message);
      },
      onExit,
    );
    client = {
      ...real,
      request: async (method, params) => {
        const call: (typeof calls)[number] = { method, params };
        calls.push(call);
        try {
          const result = await real.request(method, params);
          if (
            /^(thread\/start|thread\/resume|turn\/start|thread\/backgroundTerminals\/)/.test(method)
          )
            call.result = result;
          return result;
        } catch (error) {
          call.error = String(error);
          throw error;
        }
      },
    };
    return client;
  };
  const adapter = new MultiAdapter(
    new FakeAdapter(),
    new CodexAdapter(path.join(root, 'journal'), connect),
  );
  adapters.push(adapter);
  const create = (text: string, permissionMode: PermissionMode = 'default') => {
    const session = LiveSession.create(
      cwd,
      { text },
      {
        adapter,
        registry: new MemoryRegistry(),
        claudePath: '',
        env: process.env,
        now: Date.now,
        emit: () => {},
        model: 'codex:default',
        permissionMode,
        onError: () => {},
      },
    );
    sessions.push(session);
    return session;
  };
  const readThread = async () => {
    const start = calls.find((call) => call.method === 'thread/start');
    return client.request('thread/read', { threadId: str(rec(start?.result?.thread).id) });
  };
  const done = async (session: LiveSession) => {
    try {
      await eventually(() => ['idle', 'failed', 'needsYou'].includes(session.status), 'turn end');
    } catch (error) {
      throw new Error(
        `${error}; status=${session.status}; pending=${session.pendingRequests().length}; recentEvents=${JSON.stringify(events.slice(-20).map((event) => ({ method: event.method, itemType: rec(event.params?.item).type, status: rec(event.params?.turn).status, error: event.params?.error })))}; texts=${JSON.stringify(session.snapshot(100).items.filter((item) => item.kind === 'assistantText' || item.kind === 'system')).slice(-5000)}; rpcErrors=${JSON.stringify(calls.filter((call) => call.error).map((call) => ({ method: call.method, error: call.error })))}`,
        { cause: error },
      );
    }
    const texts = session
      .snapshot(100)
      .items.filter((item) => item.kind === 'system' || item.kind === 'assistantText');
    expect(session.status, JSON.stringify(texts).slice(-4000)).toBe('idle');
    const rootId = str(
      rec(calls.find((call) => call.method === 'thread/start')?.result?.thread).id,
    );
    const turn = [...events]
      .reverse()
      .find((event) => event.method === 'turn/completed' && event.params?.threadId === rootId);
    expect(rec(turn?.params?.turn).status).toBe('completed');
  };
  return { root, cwd, outside, events, calls, create, done, readThread, client: () => client };
};

const powershellWrite = (file: string, text: string) =>
  `powershell -NoProfile -Command "[System.IO.File]::WriteAllText('${file.replace(/'/g, "''")}', '${text}')"`;
const exists = async (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe.skipIf(!enabled)('real Codex workflows', () => {
  it('runs an ordinary read-only shell command without escalation', async () => {
    const h = await fixture();
    const session = h.create(
      'Use exec_command to run powershell -NoProfile -Command "Write-Output READ_ONLY_OK" with ordinary sandbox permissions. Do not request escalation. Do not use other tools. Reply DONE after success.',
    );
    await h.done(session);
    expect(h.calls.find((call) => call.method === 'thread/start')?.result).toMatchObject({
      sandbox: { type: 'readOnly' },
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        method: 'item/completed',
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: 'commandExecution',
            exitCode: 0,
            aggregatedOutput: expect.stringContaining('READ_ONLY_OK'),
          }),
        }),
      }),
    );
    expect(
      h.events.some((event) => event.id !== undefined && event.method?.includes('requestApproval')),
    ).toBe(false);
  });

  it.each(['acceptEdits', 'auto'] as const)(
    'edits files and runs a real Node test inside the %s workspace sandbox',
    async (permissionMode) => {
      const h = await fixture();
      const session = h.create(
        `In this disposable workspace, use apply_patch to create add.cjs exporting a function that adds two numbers, and add.test.cjs using node:test and node:assert/strict with one test asserting add(2,3) equals 5. Then run the installed Node executable at ${JSON.stringify(process.execPath)} with arguments --test add.test.cjs, using exec_command and ordinary sandbox permissions. In PowerShell use the call operator & with the quoted absolute executable path. Do not rely on node being on PATH. Everything is inside this workspace; do not request escalation, inspect unrelated folders, or use other tools. Reply DONE only after the test passes.`,
        permissionMode,
      );
      await h.done(session);
      expect(await readFile(path.join(h.cwd, 'add.cjs'), 'utf8')).toContain('exports');
      expect(await readFile(path.join(h.cwd, 'add.test.cjs'), 'utf8')).toContain('node:test');
      expect(
        h.events.some(
          (event) =>
            event.method === 'item/completed' &&
            rec(event.params?.item).type === 'commandExecution' &&
            /node.*--test.*add\.test\.cjs/.test(str(rec(event.params?.item).command)) &&
            rec(event.params?.item).exitCode === 0,
        ),
      ).toBe(true);
      expect(
        h.events.some(
          (event) => event.id !== undefined && event.method?.includes('requestApproval'),
        ),
      ).toBe(false);
      expect(h.calls.find((call) => call.method === 'thread/start')?.result).toMatchObject({
        sandbox: { type: 'workspaceWrite' },
      });
    },
  );

  it('implements a native plan inside the workspace without escalation', async () => {
    const h = await fixture();
    const output = path.join(h.cwd, 'in-workspace-plan.txt');
    const session = h.create(
      'Plan adding in-workspace-plan.txt containing the line IN_WORKSPACE_PLAN_OK. Return a concise plan without running tools or writing files.',
      'plan',
    );
    await h.done(session);
    expect(await exists(output)).toBe(false);
    expect(h.events.some((event) => rec(event.params?.item).type === 'plan')).toBe(true);
    await session.setPermissionMode('acceptEdits');
    session.send({
      text: 'Implement the plan using only apply_patch. Add in-workspace-plan.txt containing one line IN_WORKSPACE_PLAN_OK. Do not run shell commands or request escalation; the file is within the workspace and the test harness verifies it.',
    });
    await h.done(session);
    expect((await readFile(output, 'utf8')).trim()).toBe('IN_WORKSPACE_PLAN_OK');
    expect(
      h.events.some((event) => event.id !== undefined && event.method?.includes('requestApproval')),
    ).toBe(false);
  });

  it('changes Codex models and reasoning effort, and accepts a real image attachment', async () => {
    const h = await fixture();
    const session = h.create('Reply FIRST_OK. Do not use tools.', 'bypassPermissions');
    await h.done(session);
    const models = await session.supportedModels();
    const current = models.find((model) => model.value === session.header.model)!;
    const other = models.find(
      (model) =>
        model.value !== current.value &&
        model.supportedEffortLevels?.some((effort) =>
          current.supportedEffortLevels?.includes(effort),
        ),
    )!;
    expect(other).toBeDefined();
    const effort = ['low', 'medium', 'high'].find(
      (level) =>
        current.supportedEffortLevels?.includes(level) &&
        other.supportedEffortLevels?.includes(level),
    )!;
    expect(effort).toBeDefined();
    await session.setEffort(effort);
    await session.setModel(other.value);
    session.send({ text: 'Reply SWITCHED_OK. Do not use tools.' });
    await h.done(session);
    const thread = rec((await h.readThread()).thread);
    expect(thread.model).toBe(other.value.replace(/^codex:/, ''));
    expect(thread.reasoningEffort).toBe(effort);
    const png = await readFile(
      new URL('../../../../apps/desktop/src-tauri/icons/32x32.png', import.meta.url),
    );
    session.send({
      text: 'This is an image attachment transport smoke test. Reply IMAGE_OK. Do not use tools.',
      images: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }],
    });
    await h.done(session);
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'assistantText',
        markdown: expect.stringContaining('IMAGE_OK'),
      }),
    );
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'user',
        images: [expect.objectContaining({ mediaType: 'image/png' })],
      }),
    );
  });
  it('round-trips a real command approval and denial without executing the denied write', async () => {
    const h = await fixture();
    const allowed = path.join(h.outside, 'allowed.txt');
    const denied = path.join(h.outside, 'denied.txt');
    const session = h.create(
      `This is a CLI approval integration test. Run exactly this command using exec_command with sandbox_permissions="require_escalated" and a short justification requesting approval: ${powershellWrite(allowed, 'APPROVED')}. Do not use apply_patch or request_permissions. Do not run other commands. After it finishes reply APPROVED_DONE.`,
    );
    await eventually(
      () =>
        session.pendingRequests().length > 0 ||
        session.status === 'idle' ||
        session.status === 'failed',
      'command approval',
    );
    expect(
      session.pendingRequests(),
      JSON.stringify(session.snapshot(50).items).slice(-3000),
    ).toHaveLength(1);
    expect(await exists(allowed)).toBe(false);
    expect(session.status).toBe('needsYou');
    session.respond(
      session.pendingRequests().find((item) => item.kind === 'permissionRequest')!.requestId,
      { decision: 'allow' },
    );
    await h.done(session);
    expect(await readFile(allowed, 'utf8')).toBe('APPROVED');
    session.send({
      text: `Now run exactly this command using exec_command with sandbox_permissions="require_escalated" and justification requesting approval: ${powershellWrite(denied, 'DENIED')}. This test will deny it. If denied, stop and reply DENIED_DONE; do not retry or use any alternative tool.`,
    });
    await eventually(
      () =>
        session.pendingRequests().length > 0 ||
        session.status === 'idle' ||
        session.status === 'failed',
      'second command approval',
    );
    expect(session.pendingRequests()).toHaveLength(1);
    session.respond(
      session.pendingRequests().find((item) => item.kind === 'permissionRequest')!.requestId,
      {
        decision: 'deny',
        reason: 'Integration test: do not execute or retry.',
      },
    );
    await h.done(session);
    expect(await exists(denied)).toBe(false);
    expect(
      h.events.filter((event) => event.method === 'item/commandExecution/requestApproval'),
    ).toHaveLength(2);
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({ kind: 'toolCall', status: 'ok' }),
    );
  });

  it('executes a harmless YOLO write outside the workspace without prompting', async () => {
    const h = await fixture();
    const output = path.join(h.outside, 'yolo.txt');
    const session = h.create(
      `Run exactly this command using exec_command, without changing the command: ${powershellWrite(output, 'YOLO_OK')}. Do not use other tools or commands. Reply DONE after it succeeds.`,
      'bypassPermissions',
    );
    await h.done(session);
    expect(await readFile(output, 'utf8')).toBe('YOLO_OK');
    expect(
      h.events.some((event) => event.id !== undefined && event.method?.includes('requestApproval')),
    ).toBe(false);
    const start = h.calls.find((call) => call.method === 'thread/start')?.result;
    expect(start).toMatchObject({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
  });

  it('plans without writing, asks a real question, then implements only after changing mode', async () => {
    const h = await fixture();
    const output = path.join(h.outside, 'planned.txt');
    const session = h.create(
      `Plan creating the temporary fixture file ${output} containing PLAN_OK outside this workspace. First call request_user_input with one question asking whether the file should contain PLAN_OK or SOMETHING_ELSE. Do not inspect files, run commands, or write anything in this planning turn. After my answer return a concise plan.`,
      'plan',
    );
    await eventually(
      () =>
        session.pendingRequests().length > 0 ||
        session.status === 'idle' ||
        session.status === 'failed',
      'plan question',
    );
    expect(
      session.pendingRequests(),
      JSON.stringify(session.snapshot(50).items).slice(-3000),
    ).toHaveLength(1);
    const question = session.pendingRequests().find((item) => item.kind === 'permissionRequest')!;
    expect(question.toolName).toBe('AskUserQuestion');
    const questions = rec(question.input).questions as Rec[];
    session.respond(question.requestId, {
      decision: 'allow',
      updatedInput: { answers: { [str(questions[0]?.question)]: 'PLAN_OK' } },
    });
    await h.done(session);
    expect(await exists(output)).toBe(false);
    expect(h.events.some((event) => rec(event.params?.item).type === 'plan')).toBe(true);
    await session.setPermissionMode('acceptEdits');
    session.send({
      text: `Implement the plan now. The fixture is deliberately outside the workspace so approval is expected. Run exactly this command using exec_command with sandbox_permissions="require_escalated" and a short justification asking to create the authorized fixture: ${powershellWrite(output, 'PLAN_OK')}. Do not run other commands or tools.`,
    });
    await eventually(
      () =>
        session.pendingRequests().length > 0 ||
        session.status === 'idle' ||
        session.status === 'failed',
      'implementation approval',
    );
    const approval = session.pendingRequests().find((item) => item.kind === 'permissionRequest')!;
    expect(approval).toBeDefined();
    session.respond(approval.requestId, { decision: 'allow' });
    await h.done(session);
    expect(await exists(output), JSON.stringify(session.snapshot(100).items).slice(-5000)).toBe(
      true,
    );
    expect((await readFile(output, 'utf8')).trimEnd()).toBe('PLAN_OK');
    expect(
      h.calls
        .filter((call) => call.method === 'turn/start')
        .map((call) => rec(call.params.collaborationMode).mode),
    ).toEqual(['plan', 'default']);
  });

  it('uses the native Auto reviewer to approve a harmless escalated fixture write', async () => {
    const h = await fixture();
    const output = path.join(h.outside, 'auto-reviewed.txt');
    const session = h.create(
      `This integration test explicitly authorizes writing only this temporary fixture file. Run exactly this command using exec_command with sandbox_permissions="require_escalated" and justification "Create the authorized temporary integration-test fixture": ${powershellWrite(output, 'AUTO_REVIEW_OK')}. Do not use another tool or command. Reply DONE after success.`,
      'auto',
    );
    await h.done(session);
    expect(await readFile(output, 'utf8')).toBe('AUTO_REVIEW_OK');
    expect(h.calls.find((call) => call.method === 'thread/start')?.result).toMatchObject({
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'workspaceWrite' },
    });
    expect(h.calls.find((call) => call.method === 'turn/start')?.params.approvalsReviewer).toBe(
      'auto_review',
    );
    expect(session.pendingRequests()).toHaveLength(0);
    expect(
      h.events.some((event) => event.id !== undefined && event.method?.includes('requestApproval')),
    ).toBe(false);
  });

  it('lists a real background terminal in Activity and stops it with the native task control', async () => {
    const h = await fixture();
    const session = h.create(
      'Run powershell -NoProfile -Command "Start-Sleep -Seconds 120" using exec_command with yield_time_ms=1000. Leave the returned unified-exec session running in the background and immediately reply BACKGROUND_READY. Do not call write_stdin, wait, or kill it; the integration test will stop it through the app.',
      'bypassPermissions',
    );
    await eventually(
      () => session.tasks().some((task) => task.kind === 'shell' && task.status === 'running'),
      'background terminal in Activity',
    );
    const task = session
      .tasks()
      .find((task) => task.kind === 'shell' && task.status === 'running')!;
    await session.stopTask(task.taskId);
    await eventually(
      () => session.tasks().find((item) => item.taskId === task.taskId)?.status === 'stopped',
      'stopped terminal',
    );
    expect(
      h.calls.find((call) => call.method === 'thread/backgroundTerminals/terminate')?.result,
    ).toMatchObject({ terminated: true });
    const thread = h.calls.find((call) => call.method === 'thread/start')?.result?.thread;
    const remaining = await h
      .client()
      .request('thread/backgroundTerminals/list', { threadId: str(rec(thread).id) });
    expect(remaining.data).toEqual([]);
    await h.done(session);
  });

  it('lists a real child agent in Activity and interrupts only that owned agent', async () => {
    const h = await fixture();
    const session = h.create(
      'This is an isolated background-agent integration test. Use spawn_agent to create exactly one child agent with this task: "Run powershell -NoProfile -Command \\"Start-Sleep -Seconds 120\\" using exec_command and wait for it to finish, then reply CHILD_DONE. Do not inspect files or do other work." After spawning, immediately reply AGENT_READY without waiting for or closing the child. The test harness will stop it through the app.',
      'bypassPermissions',
    );
    await eventually(
      () => session.tasks().some((task) => task.kind === 'agent' && task.status === 'running'),
      'background agent in Activity',
    );
    const task = session
      .tasks()
      .find((task) => task.kind === 'agent' && task.status === 'running')!;
    await session.stopTask(task.taskId);
    await eventually(
      () => session.tasks().find((item) => item.taskId === task.taskId)?.status === 'stopped',
      'stopped agent',
    );
    expect(
      h.calls.some(
        (call) =>
          call.method === 'turn/interrupt' &&
          call.params.threadId !==
            str(rec(h.calls.find((call) => call.method === 'thread/start')?.result?.thread).id),
      ),
    ).toBe(true);
    await h.done(session);
  });

  it('queues two inputs behind a real running turn and interrupts subsequent running work', async () => {
    const h = await fixture();
    const session = h.create(
      'Run powershell -NoProfile -Command "Start-Sleep -Seconds 4" with exec_command and yield_time_ms=1000, wait for completion, then reply FIRST_DONE. Do not use other tools.',
      'bypassPermissions',
    );
    await eventually(
      () => h.events.some((event) => rec(event.params?.item).type === 'commandExecution'),
      'running command',
    );
    expect(session.send({ text: 'For the next answer remember the word QUEUE_ALPHA.' })).toEqual({
      queued: true,
    });
    expect(
      session.send({ text: 'Reply with QUEUE_ALPHA and QUEUE_BETA together. Do not use tools.' }),
    ).toEqual({ queued: true });
    await eventually(
      () => h.events.filter((event) => event.method === 'turn/completed').length >= 2,
      'queued turn completion',
    );
    await h.done(session);
    expect(h.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'assistantText',
        markdown: expect.stringMatching(/QUEUE_ALPHA[\s\S]*QUEUE_BETA/),
      }),
    );
    session.send({
      text: 'Run powershell -NoProfile -Command "Start-Sleep -Seconds 30" with exec_command and yield_time_ms=1000. Wait for it to finish before answering.',
    });
    const before = h.events.filter((event) => event.method === 'item/started').length;
    await eventually(
      () =>
        h.events.filter((event) => event.method === 'item/started').length > before &&
        session.status === 'working',
      'interruptible work',
    );
    await session.interrupt();
    await eventually(
      () => h.events.filter((event) => event.method === 'turn/completed').length >= 3,
      'interrupted turn completion',
    );
    expect(
      rec([...h.events].reverse().find((event) => event.method === 'turn/completed')?.params?.turn)
        .status,
    ).toBe('interrupted');
    await eventually(() => session.status === 'idle', 'idle after interrupt');
    expect(session.pendingRequests()).toHaveLength(0);
  });
});
