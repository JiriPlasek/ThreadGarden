import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_ICON_BYTES, ProjectIcons } from '../../src/history/project-icons.js';
import { slack } from './perf-helpers.js';

const root = mkdtempSync(path.join(tmpdir(), 'pahub-icons-perf-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, body: string | Buffer): void => {
  const p = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

/**
 * 50 projects, each a worst case for the search: 500 files at its root, an
 * index.html with 50 links to missing icons, 30 apps without one, and the
 * icon as the last fixed path of the last package, a maximal SVG.
 */
const PROJECTS = 50;
const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(MAX_ICON_BYTES - 50)}</svg>`;
for (let p = 0; p < PROJECTS; p++) {
  const base = `p${p}`;
  for (let i = 0; i < 500; i++) put(`${base}/file-${i}.txt`, '');
  const links = Array.from({ length: 50 }, (_, i) => `<link rel="icon" href="/gone-${i}.png">`);
  put(`${base}/index.html`, `<html><head>${links.join('\n')}</head></html>`);
  for (let a = 0; a < 30; a++) put(`${base}/apps/a${a}/README.md`, '');
  put(`${base}/packages/zz/.github/logo.svg`, bigSvg);
}

describe('project icons perf', () => {
  it('searching 50 worst-case projects at once never stalls the event loop > 50 ms', async () => {
    const icons = new ProjectIcons();
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t0 = performance.now();
    const urls = await Promise.all(
      Array.from({ length: PROJECTS }, (_, p) => icons.get(`p${p}`, path.join(root, `p${p}`))),
    );
    const total = performance.now() - t0;
    h.disable();
    const maxMs = h.max / 1e6;
    console.info(
      `icons for ${PROJECTS} projects: total ${total.toFixed(0)} ms, max event-loop delay ${maxMs.toFixed(1)} ms`,
    );
    // Within the search budget, so every one is found.
    expect(urls.every((u) => u?.startsWith('data:image/svg+xml;base64,'))).toBe(true);
    expect(maxMs).toBeLessThanOrEqual(50 * slack);
  }, 300_000);
});
