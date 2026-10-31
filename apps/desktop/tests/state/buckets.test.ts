import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import { AgentsState } from '../../src/lib/state/agents.svelte';
import { setup, summary } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';

type SetParams = { sessionIds: string[]; bucket: string; holdUntil?: number; holdNote?: string };
type ListParams = { place: { kind: string }; limit: number };

const flush = () => new Promise((r) => setTimeout(r, 10));

/** `chat.setBucket` refuses archiving the ids in `skip` with their reason, once each. */
const withBuckets = (skip: Record<string, string> = {}) =>
  setup((server) => {
    const pending = { ...skip };
    server.handlers['chat.setBucket'] = (p) => {
      const { sessionIds, bucket } = p as SetParams;
      const skipped =
        bucket === 'archived'
          ? sessionIds.flatMap((id) => {
              const reason = pending[id];
              return reason ? [{ sessionId: id, reason }] : [];
            })
          : [];
      return { updated: sessionIds.length - skipped.length, skipped };
    };
    server.handlers['chat.end'] = (p) => {
      delete pending[(p as { sessionId: string }).sessionId];
      return {};
    };
    server.handlers['chat.archiveOlder'] = (p) => ({
      archived: (p as { dryRun?: boolean }).dryRun ? 12 : 11,
    });
  });

const chat = (id: string, over = {}) => summary(id, { title: `Chat ${id}`, ...over });

describe('buckets: actions (v1.2 §3)', () => {
  it('archive, make active and hold send chat.setBucket', async () => {
    const { server, app } = await withBuckets();
    await app.buckets.archive([chat('a')]);
    await app.buckets.activate([chat('b'), chat('c')]);
    app.buckets.hold([chat('d')]);
    expect(app.buckets.holding?.targets.map((t) => t.sessionId)).toEqual(['d']);
    await app.buckets.saveHold({ until: 1_900_000_000_000, note: '  waiting for Petr  ' });
    expect(app.buckets.holding).toBeNull();
    await app.buckets.saveHold({ until: undefined, note: '' }); // nothing pending: no request
    app.buckets.hold([chat('e')]);
    await app.buckets.saveHold({ until: undefined, note: '   ' });
    expect(server.calls('chat.setBucket').map((c) => c.params)).toEqual([
      { sessionIds: ['a'], bucket: 'archived' },
      { sessionIds: ['b', 'c'], bucket: 'active' },
      {
        sessionIds: ['d'],
        bucket: 'onHold',
        holdUntil: 1_900_000_000_000,
        holdNote: 'waiting for Petr',
      },
      { sessionIds: ['e'], bucket: 'onHold' },
    ]);
    expect(app.buckets.notice).toBeNull();
  });

  it('archiving a chat Threadgarden runs asks to end it, then ends and archives it', async () => {
    const { server, app } = await withBuckets({ a: 'LIVE' });
    await app.buckets.archive([chat('a', { live: true })]);
    expect(app.buckets.ending?.sessionId).toBe('a');
    expect(server.calls('chat.end')).toHaveLength(0);

    await app.buckets.endAndArchive();
    expect(server.sent.map((s) => s.method).filter((m) => m.startsWith('chat.'))).toEqual([
      'chat.setBucket',
      'chat.end',
      'chat.setBucket',
    ]);
    expect(server.calls('chat.setBucket')[1]!.params).toEqual({
      sessionIds: ['a'],
      bucket: 'archived',
    });
    expect(app.buckets.ending).toBeNull();
    expect(app.buckets.notice).toBeNull();
  });

  it('a chat running outside Threadgarden is explained, not retried', async () => {
    const { server, app } = await withBuckets({ x: 'RUNNING' });
    await app.buckets.archive([chat('x', { title: 'terminal chat' })]);
    expect(app.buckets.ending).toBeNull();
    expect(app.buckets.notice).toMatch(/“terminal chat” is running outside pahub/);
    expect(server.calls('chat.setBucket')).toHaveLength(1);
    expect(server.calls('chat.end')).toHaveLength(0);
  });

  it('bulk archive reports the chats it skipped', async () => {
    const { app } = await withBuckets({ b: 'LIVE', c: 'LIVE', d: 'RUNNING', e: 'NOT_FOUND' });
    await app.buckets.archive(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => chat(id)));
    expect(app.buckets.ending).toBeNull();
    const notice = app.buckets.notice ?? '';
    expect(notice).toMatch(/^Archived 2 chats\./);
    expect(notice).toMatch(/2 chats were not archived because Threadgarden is running them/);
    expect(notice).toMatch(/1 chat runs outside pahub/);
    expect(notice).toMatch(/1 chat could not be moved/);
    app.buckets.dismissNotice();
    expect(app.buckets.notice).toBeNull();
  });

  it('a failed request is reported', async () => {
    const { server, app } = await withBuckets();
    server.handlers['chat.setBucket'] = () => {
      throw new RpcFail('INTERNAL', 'disk full');
    };
    await app.buckets.archive([chat('a')]);
    expect(app.buckets.notice).toMatch(/Could not archive.*disk full/);
    // A failed hold keeps the dialog open and rethrows (the dialog shows it).
    app.buckets.hold([chat('a')]);
    await expect(app.buckets.saveHold({ until: undefined, note: '' })).rejects.toThrow(/disk full/);
    expect(app.buckets.holding).not.toBeNull();
  });

  it('"Archive all older than 30 days" counts first (dry run), then archives', async () => {
    const { server, app } = await withBuckets();
    await app.buckets.askArchiveOlder('p1');
    expect(app.buckets.archivingOlder).toEqual({ projectId: 'p1', count: 12 });
    await app.buckets.archiveOlder();
    expect(server.calls('chat.archiveOlder').map((c) => c.params)).toEqual([
      { projectId: 'p1', olderThanDays: 30, dryRun: true },
      { projectId: 'p1', olderThanDays: 30 },
    ]);
    expect(app.buckets.archivingOlder).toBeNull();

    // The Active place: no project.
    await app.buckets.askArchiveOlder(undefined);
    expect(server.calls('chat.archiveOlder').at(-1)!.params).toEqual({
      olderThanDays: 30,
      dryRun: true,
    });

    // Nothing to archive: said so, no confirmation.
    server.handlers['chat.archiveOlder'] = () => ({ archived: 0 });
    app.buckets.archivingOlder = null;
    await app.buckets.askArchiveOlder(undefined);
    expect(app.buckets.archivingOlder).toBeNull();
    expect(app.buckets.notice).toMatch(/No chats older than 30 days/);
  });
});

describe('buckets: the agents strip', () => {
  it('takes idle live chats from Active and On hold, not Archived', async () => {
    const { server, client } = await setup((server) => {
      server.handlers['sessions.list'] = (p) => {
        const kind = (p as ListParams).place.kind;
        if (kind === 'onHold') return { items: [summary('held', { status: 'idle', live: true })] };
        if (kind === 'active') return { items: [summary('act', { status: 'idle', live: true })] };
        return { items: [] };
      };
    });
    const agents = new AgentsState();
    agents.init(client);
    await agents.refresh();
    await flush();
    const kinds = server.calls('sessions.list').map((c) => (c.params as ListParams).place.kind);
    expect(kinds).toContain('onHold');
    expect(kinds).toContain('active');
    expect(kinds).not.toContain('archived');
    expect(kinds).not.toContain('all');
    expect(agents.items.map((s) => s.sessionId).sort()).toEqual(['act', 'held']);
  });
});

describe('buckets: open chats follow bucket changes', () => {
  it('re-reads the summary of an open chat named by sessions.changed', async () => {
    const { server, app } = await setup((server) => {
      server.handlers['sessions.summaries'] = (p) => ({
        items: (p as { sessionIds: string[] }).sessionIds.map((id) =>
          summary(id, { bucket: 'onHold', holdNote: 'later' }),
        ),
      });
    });
    app.tabs.openTab('a');
    await flush();
    expect(app.chats.get('a')?.summary?.bucket).toBe('active');
    server.push('sessions.changed', { sessionIds: ['zz'] });
    await flush();
    expect(server.calls('sessions.summaries')).toHaveLength(0);
    server.push('sessions.changed', { sessionIds: ['a', 'zz'] });
    await flush();
    expect(server.calls('sessions.summaries').map((c) => c.params)).toEqual([
      { sessionIds: ['a'] },
    ]);
    expect(app.chats.get('a')?.summary?.bucket).toBe('onHold');
    expect(app.chats.get('a')?.summary?.holdNote).toBe('later');
  });
});

describe('open chats outside the selected place (C1 I3: generated titles)', () => {
  it('a new title reaches the open chat and its tab, and a background tab, though neither is listed', async () => {
    const titles: Record<string, string> = { a: 'Chat a', b: 'Chat b' };
    const { server, app, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: [summary('x')] });
      // Restored tabs: 'a' is shown (loaded), 'b' was never shown (only summarised).
      server.handlers['uiState.get'] = (p) => ({
        value: (p as { key: string }).key === 'tabs' ? { open: ['a', 'b'], active: 'a' } : null,
      });
      server.handlers['sessions.summaries'] = (p) => ({
        items: (p as { sessionIds: string[] }).sessionIds.map((id) =>
          summary(id, { title: titles[id] ?? id }),
        ),
      });
      server.handlers['chat.open'] = (p) => {
        const id = (p as { sessionId: string }).sessionId;
        return {
          summary: summary(id, { title: titles[id] ?? id }),
          header: {},
          items: [],
          hasMore: false,
          seq: 1,
        };
      };
    });
    await app.tabs.restore();
    render(TabsBar, { context });
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    await waitFor(() => expect(app.chats.get('a')?.loaded).toBe(true));
    await waitFor(() => expect(app.chats.summaryOf('b')?.title).toBe('Chat b'));
    expect(app.chats.get('b')).toBeUndefined();

    titles.a = 'Fix the login redirect';
    titles.b = 'Plan the release';
    server.push('sessions.changed', { sessionIds: ['a'] });
    server.push('sessions.changed', { sessionIds: ['b'] });
    await waitFor(() => {
      const names = screen.getAllByRole('tab').map((t) => t.textContent ?? '');
      expect(names.some((n) => n.includes('Fix the login redirect'))).toBe(true);
      expect(names.some((n) => n.includes('Plan the release'))).toBe(true);
    });
    expect(app.chats.get('a')?.summary?.title).toBe('Fix the login redirect');
  });

  it('an unchanged summary is not replaced (no re-render for every re-index)', async () => {
    const fixed = summary('a', { lastActivity: 1_000 });
    const { server, app } = await setup((server) => {
      server.handlers['chat.open'] = () => ({
        summary: fixed,
        header: {},
        items: [],
        hasMore: false,
        seq: 1,
      });
      server.handlers['sessions.summaries'] = () => ({
        items: [{ ...fixed, lastActivity: 2_000, preview: 'newer preview' }],
      });
    });
    app.tabs.openTab('a');
    await flush();
    const before = app.chats.get('a')!.summary;
    server.push('sessions.changed', { sessionIds: ['a'] });
    await flush();
    expect(server.calls('sessions.summaries')).toHaveLength(1);
    expect(app.chats.get('a')!.summary).toBe(before);
  });
});
