import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Catalog } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { registerHistoryHandlers } from '../../src/server/handlers/history.js';
import { Router } from '../../src/server/router.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);

const setup = (o: { missing?: string[]; icons?: { get: () => Promise<string | null> } } = {}) => {
  const db = openDb(':memory:');
  const catalog = new Catalog({ db, externals: () => [] });
  const router = new Router();
  registerHistoryHandlers(router, {
    db,
    catalog,
    quickSearch: () => [],
    folderExists: (p) => !(o.missing ?? []).includes(p),
    ...(o.icons ? { icons: o.icons } : {}),
  });
  const call = async (projectId: string) => {
    const r = await router.dispatch(
      { id: 1, method: 'projects.icon', params: { projectId } } as never,
      { clientId: 'c', origin: 'local' },
    );
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as { dataUrl: string | null };
  };
  return { db, call };
};

describe('projects.icon', () => {
  it("answers the icon found in the project's folder", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'threadgarden-icon-api-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'favicon.ico'), ICO);
    const t = setup();
    t.db.upsertProject({ projectId: 'p', path: root, displayName: 'p' });
    expect(await t.call('p')).toEqual({
      dataUrl: `data:image/x-icon;base64,${ICO.toString('base64')}`,
    });
  });

  it('answers null for a project without an icon', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'threadgarden-icon-api-'));
    dirs.push(root);
    const t = setup();
    t.db.upsertProject({ projectId: 'p', path: root, displayName: 'p' });
    expect(await t.call('p')).toEqual({ dataUrl: null });
  });

  it('answers null at once, without searching, when the folder is missing', async () => {
    let searched = 0;
    const t = setup({
      missing: ['/gone'],
      icons: {
        get: async () => {
          searched++;
          return 'data:image/png;base64,AA==';
        },
      },
    });
    t.db.upsertProject({ projectId: 'g', path: '/gone', displayName: 'gone' });
    expect(await t.call('g')).toEqual({ dataUrl: null });
    expect(searched).toBe(0);
  });

  it('rejects an unknown project', async () => {
    const t = setup();
    await expect(t.call('nope')).rejects.toThrow(/NOT_FOUND/);
  });
});
