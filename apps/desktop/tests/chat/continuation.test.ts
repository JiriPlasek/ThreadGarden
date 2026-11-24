import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import ChatHeader from '../../src/lib/components/chat/ChatHeader.svelte';
import { LOCAL, M1, setup, setupTwoMachines, summary } from '../layout/harness';
import { SCOPE_CONTEXT } from '../../src/lib/state/context';
import { RpcFail } from '../service/fake-ws';

const menu = async (name: string | RegExp) => {
  const button = screen.getByRole('button', { name: 'Chat state' });
  button.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
  await userEvent.click(button);
  return screen.findByRole('menuitem', { name });
};

it('confirms a Codex continuation, keeps the old tab and opens the new chat with a backlink', async () => {
  const { app, server, context } = await setup((s) => {
    s.handlers['chat.continue'] = (params) => ({
      sessionId: (params as { targetSessionId: string }).targetSessionId,
    });
  });
  await app.chats.open('a');
  app.tabs.openTab({ machineId: LOCAL, sessionId: 'a' });
  render(ChatHeader, { context, props: { chat: app.chats.get('a')! } });
  await userEvent.click(await menu('Continue in Codex…'));
  expect(server.calls('chat.continue')).toHaveLength(0);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue in Codex' }));
  await waitFor(() => expect(server.calls('chat.continue')).toHaveLength(1));
  const request = server.calls('chat.continue')[0]!.params as {
    sessionId: string;
    targetSessionId: string;
    stopSource: boolean;
  };
  expect(request.sessionId).toBe('a');
  expect(request.stopSource).toBe(true);
  expect(request.targetSessionId).toMatch(/^codex-/);
  await waitFor(() => expect(app.tabs.active).toBe(LOCAL + '/' + request.targetSessionId));
  expect(app.tabs.open).toContain(LOCAL + '/a');
  expect(app.chats.get('a')!.continuationLinks.to).toContain(request.targetSessionId);
  expect(server.calls('chat.send')).toHaveLength(0);
});

it('uses the opposite action for a Codex source and routes it to that machine', async () => {
  const id = 'codex-source';
  const { app, server, remote, context } = await setupTwoMachines({
    configureRemote: (s) => {
      s.handlers['chat.open'] = () => ({
        summary: summary(id),
        header: {},
        items: [],
        tasks: [],
        hasMore: false,
        seq: 0,
      });
      s.handlers['chat.continue'] = (params) => ({
        sessionId: (params as { targetSessionId: string }).targetSessionId,
      });
    },
  });
  const scope = app.scopes.get(M1)!;
  await scope.chats.open(id);
  context.set(SCOPE_CONTEXT, scope);
  render(ChatHeader, { context, props: { chat: scope.chats.get(id)! } });
  await userEvent.click(await menu('Continue in Claude…'));
  await userEvent.click(await screen.findByRole('button', { name: 'Continue in Claude' }));
  await waitFor(() => expect(remote.calls('chat.continue')).toHaveLength(1));
  const params = remote.calls('chat.continue')[0]!.params as { targetSessionId: string };
  expect(params.targetSessionId).not.toMatch(/^codex-/);
  expect(server.calls('chat.continue')).toHaveLength(0);
  await waitFor(() => expect(app.tabs.active).toBe(M1 + '/' + params.targetSessionId));
});

it('keeps the confirmation open on failure and reuses the target id on retry', async () => {
  let fail = true;
  const { app, server, context } = await setup((s) => {
    s.handlers['chat.continue'] = (params) => {
      if (fail) throw new RpcFail('CODEX_MISSING', 'Install Codex first');
      return { sessionId: (params as { targetSessionId: string }).targetSessionId };
    };
  });
  await app.chats.open('a');
  render(ChatHeader, { context, props: { chat: app.chats.get('a')! } });
  await userEvent.click(await menu('Continue in Codex…'));
  await userEvent.click(await screen.findByRole('button', { name: 'Continue in Codex' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Install Codex first');
  fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Continue in Codex' }));
  await waitFor(() => expect(server.calls('chat.continue')).toHaveLength(2));
  expect(server.calls('chat.continue')[1]!.params).toEqual(
    server.calls('chat.continue')[0]!.params,
  );
});

it('hides continuation on read-only copies', async () => {
  const { app, context } = await setup();
  await app.chats.open('a');
  render(ChatHeader, { context, props: { chat: app.chats.get('a')!, readOnly: true } });
  await menu(/^Rename/);
  expect(screen.queryByRole('menuitem', { name: /Continue in/ })).toBeNull();
});
