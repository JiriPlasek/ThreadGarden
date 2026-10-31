import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Db, openDb } from '../../src/history/db.js';
import { migrate } from '../../src/history/migrations.js';
import type { SDKSessionInfo } from '../../src/sdk/adapter.js';

const tables = (db: ReturnType<typeof openDb>): string[] =>
  (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

const info = (id: string, over: Partial<SDKSessionInfo> = {}): SDKSessionInfo => ({
  sessionId: id,
  summary: 's',
  lastModified: 100,
  fileSize: 10,
  ...over,
});

describe('migrations', () => {
  it('create all tables idempotently', () => {
    const db = openDb(':memory:');
    migrate(db.raw);
    migrate(db.raw);
    const names = tables(db);
    for (const t of [
      'sessions',
      'projects',
      'messages_fts',
      'meta',
      'drafts',
      'live_sessions',
      'settings',
      'ui_state',
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('on upgrade, notifyOnFinish starts as the stored notifications setting (v1.1)', () => {
    /** A pahub.db as v1.1 found it: the first three steps, `notifications` maybe stored. */
    const before = (notifications: string | undefined) => {
      const raw = new DatabaseSync(':memory:');
      migrate(raw);
      raw.exec('DELETE FROM settings');
      raw.exec('PRAGMA user_version = 3');
      if (notifications !== undefined) {
        raw
          .prepare("INSERT INTO settings (key, json) VALUES ('notifications', ?)")
          .run(notifications);
      }
      migrate(raw);
      return new Db(raw);
    };
    // A user who silenced pahub stays silenced…
    const silenced = before('false');
    expect(silenced.getSettings()).toMatchObject({ notifications: false, notifyOnFinish: false });
    // …and from then on the two settings are independent.
    silenced.patchSettings({ notifications: true });
    expect(silenced.getSettings()).toMatchObject({ notifications: true, notifyOnFinish: false });
    expect(before('true').getSettings().notifyOnFinish).toBe(true);
    expect(before(undefined).getSettings().notifyOnFinish).toBe(true);
    // A stored value that is not a boolean is not copied (it would void every setting).
    expect(before('"loud"').getSettings().notifyOnFinish).toBe(true);
    // A new install: turning notifications off later leaves notifyOnFinish alone.
    const fresh = openDb(':memory:');
    fresh.patchSettings({ notifications: false });
    expect(fresh.getSettings()).toMatchObject({ notifications: false, notifyOnFinish: true });
  });
});

describe('Db settings', () => {
  const store = (db: Db, key: string, json: string): void => {
    db.raw
      .prepare(
        'INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
      )
      .run(key, json);
  };

  it('an invalid stored value falls back to its own default, never voiding the others', () => {
    const db = openDb(':memory:');
    db.patchSettings({ notifications: false, idleReclaimMinutes: 3, accent: 'teal' });
    store(db, 'theme', '"purple"');
    store(db, 'enterToSend', 'not json');
    store(db, 'darkStyle', '"oled-ultra"');
    store(db, 'codeFont', '{"family":1}');
    store(db, 'retired', '"setting from an older pahub"');
    const s = db.getSettings();
    expect(s).toMatchObject({
      notifications: false,
      idleReclaimMinutes: 3,
      accent: 'teal',
      theme: 'system',
      enterToSend: true,
      darkStyle: 'default',
      codeFont: null,
    });
    expect(s).not.toHaveProperty('retired');
    db.close();
  });

  it('stores the v1.3 appearance settings, defaulting to today’s look', () => {
    const db = openDb(':memory:');
    expect(db.getSettings()).toMatchObject({
      accent: 'graphite',
      darkStyle: 'default',
      lightStyle: 'default',
      uiFont: 'inter',
      codeFont: null,
    });
    const after = db.patchSettings({
      accent: 'violet',
      darkStyle: 'midnight',
      lightStyle: 'warm',
      uiFont: 'system',
      codeFont: 'Fira Code',
    });
    expect(after).toMatchObject({
      accent: 'violet',
      darkStyle: 'midnight',
      lightStyle: 'warm',
      uiFont: 'system',
      codeFont: 'Fira Code',
    });
    expect(db.patchSettings({ codeFont: null }).codeFont).toBeNull();
    db.close();
  });

  it('sanitises a code font stored by hand', () => {
    const db = openDb(':memory:');
    store(db, 'codeFont', JSON.stringify('Fira"; } * { color: red'));
    expect(db.getSettings().codeFont).toBe('Fira color red');
    db.close();
  });
});

describe('Db', () => {
  it('searchFts finds substring "arit" in "parity"', () => {
    const db = openDb(':memory:');
    db.setFts('a', 'we checked the parity of the counter');
    db.setFts('b', 'nothing relevant here at all');
    const hits = db.searchFts('arit', 10);
    expect(hits.map((h) => h.sessionId)).toEqual(['a']);
    expect(hits[0]?.snippet).toContain('parity');
    db.close();
  });

  it('searchFts treats quotes and operators literally and ignores too-short queries', () => {
    const db = openDb(':memory:');
    db.setFts('a', 'say "hello" AND goodbye');
    expect(db.searchFts('"hello"', 5)).toHaveLength(1);
    expect(db.searchFts('ab', 5)).toEqual([]);
    db.close();
  });

  it('setFts replaces earlier text and returns one hit per session', () => {
    const db = openDb(':memory:');
    db.setFts('a', 'alpha beta gamma '.repeat(20_000));
    expect(db.searchFts('alpha', 10)).toHaveLength(1);
    db.setFts('a', 'delta');
    expect(db.searchFts('alpha', 10)).toEqual([]);
    db.close();
  });

  it('needsReindex follows markIndexed and upsert keeps indexed marks', () => {
    const db = openDb(':memory:');
    const i = info('a');
    expect(db.needsReindex(i)).toBe(true);
    db.upsertSession(i, 'p');
    expect(db.needsReindex(i)).toBe(true);
    db.markIndexed(i);
    db.upsertSession(i, 'p');
    expect(db.needsReindex(i)).toBe(false);
    expect(db.needsReindex(info('a', { lastModified: 101 }))).toBe(true);
    expect(db.needsReindex(info('a', { fileSize: 11 }))).toBe(true);
    db.close();
  });

  it('lists sessions newest first with cursor paging and filters', () => {
    const db = openDb(':memory:');
    for (let n = 0; n < 5; n++)
      db.upsertSession(info(`s${n}`, { lastModified: n }), n < 3 ? 'p1' : 'p2');
    const first = db.listSessions({}, 2, undefined);
    expect(first.items.map((s) => s.sessionId)).toEqual(['s4', 's3']);
    const second = db.listSessions({}, 2, first.nextCursor);
    expect(second.items.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    const last = db.listSessions({}, 2, second.nextCursor);
    expect(last.items.map((s) => s.sessionId)).toEqual(['s0']);
    expect(last.nextCursor).toBeUndefined();
    expect(db.listSessions({ projectId: 'p2' }, 10, undefined).items).toHaveLength(2);
    expect(
      db.listSessions({ ids: ['s0', 's4'] }, 10, undefined).items.map((s) => s.sessionId),
    ).toEqual(['s4', 's0']);
    db.close();
  });

  it('stores meta, drafts, settings, ui state and live sessions', () => {
    const db = openDb(':memory:');
    db.upsertSession(info('a'), 'p');
    db.setCustomTitle('a', 'Mine');
    db.setSessionPinned('a', true);
    expect(db.getSession('a')).toMatchObject({ customTitle: 'Mine', pinned: true });
    db.setCustomTitle('a', null);
    expect(db.getSession('a')?.customTitle).toBeNull();

    db.setDraft('k', 'hello', 5);
    expect(db.getDraft('k')).toEqual({ text: 'hello', updatedAt: 5 });
    db.deleteDraft('k');
    expect(db.getDraft('k')).toBeUndefined();

    expect(db.getSettings().idleReclaimMinutes).toBe(15);
    db.patchSettings({ idleReclaimMinutes: 3 });
    expect(db.getSettings()).toMatchObject({ idleReclaimMinutes: 3, theme: 'system' });

    db.setUiState('x', { a: 1 });
    expect(db.getUiState('x')).toEqual({ a: 1 });
    expect(db.getUiState('nope')).toBeUndefined();

    db.markLive('a', '/w');
    expect(db.listLive()).toEqual([{ sessionId: 'a', cwd: '/w' }]);
    db.markEnded('a');
    expect(db.listLive()).toEqual([]);
    db.close();
  });

  it('a rebuild discards staged rows orphaned by a crash', () => {
    const db = openDb(':memory:');
    db.setFts('a', 'original zebra text');
    // crash leftovers: rows staged under the next generation, never committed
    db.raw
      .prepare('INSERT INTO messages_fts (session_id, text) VALUES (?, ?)')
      .run('a#2', 'orphan giraffe');
    expect(db.searchFts('giraffe', 5)).toEqual([]);
    const stage = db.stageFts('a');
    db.addFtsChunk(stage.key, 'fresh walrus text');
    db.commitFts('a', stage.gen);
    expect(db.searchFts('walrus', 5)).toHaveLength(1);
    expect(db.searchFts('giraffe', 5)).toEqual([]);
    expect(db.searchFts('zebra', 5)).toEqual([]);
    db.setFts('a', 'second walrus');
    const n = db.raw
      .prepare("SELECT count(*) AS n FROM messages_fts WHERE session_id LIKE 'a#%'")
      .get();
    expect(n?.n).toBe(1);
    db.close();
  });
});

// ── v1.2 C1: chat titles ──

describe('v1.2 chat titles', () => {
  it('stores provisional and generated titles apart from the custom title', () => {
    const db = openDb(':memory:');
    expect(tables(db)).toContain('chat_titles');
    expect(db.metaOf('x')).toMatchObject({
      customTitle: null,
      autoTitle: null,
      generatedTitle: null,
    });
    db.setAutoTitle('x', 'Provisional');
    db.setGeneratedTitle('x', 'Generated');
    db.setCustomTitle('x', 'Custom');
    expect(db.metaOf('x')).toMatchObject({
      customTitle: 'Custom',
      autoTitle: 'Provisional',
      generatedTitle: 'Generated',
    });
    // Each write leaves the other fields alone.
    db.setAutoTitle('x', 'Provisional 2');
    expect(db.metaOf('x')).toMatchObject({
      autoTitle: 'Provisional 2',
      generatedTitle: 'Generated',
    });
    db.close();
  });

  it('session rows carry the pahub titles (indexed or not yet)', () => {
    const db = openDb(':memory:');
    db.setAutoTitle('s1', 'Provisional');
    db.upsertSession(info('s1', { summary: 'first', firstPrompt: 'first' }), 'p');
    expect(db.getSession('s1')).toMatchObject({ autoTitle: 'Provisional', generatedTitle: null });
    db.setGeneratedTitle('s1', 'Generated');
    expect(db.listSessions({}, 10, undefined).items[0]).toMatchObject({
      autoTitle: 'Provisional',
      generatedTitle: 'Generated',
    });
    db.close();
  });

  it('upgrading a v1.2 B1 database keeps everything and adds the titles table', () => {
    const raw = new DatabaseSync(':memory:');
    migrate(raw, 5);
    raw.prepare("INSERT INTO meta (session_id, custom_title) VALUES ('s', 'Kept')").run();
    migrate(raw);
    const db = new Db(raw);
    expect(db.metaOf('s')).toMatchObject({ customTitle: 'Kept', autoTitle: null });
    db.close();
  });
});
