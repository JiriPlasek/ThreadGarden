/**
 * Quick switcher search (Ctrl+K, spec §6.1): fuzzy match over chat titles and
 * project names (`fuzzysort`), merged with full-text hits from the index.
 * v1.2: archived chats are searched too, ranked on their own; their hits are
 * flagged, come after every other hit and only fill the slots those leave
 * (the UI groups them last).
 */
import fuzzysort, { type Prepared } from 'fuzzysort';
import type { Catalog } from './catalog.js';
import type { Db } from './db.js';

export type QuickHit = {
  sessionId: string;
  title: string;
  projectName: string;
  snippet?: string;
  score: number;
  archived?: boolean;
};

const PROJECT_WEIGHT = 0.6;
const FTS_SCORE = 0.2;
/** fuzzysort's default (0.5) drops loose abbreviations like "flxcap"; a switcher should keep them. */
const THRESHOLD = 0.25;
const CACHE_MAX = 50_000;

export const createQuickSearch = (
  db: Db,
  catalog: Catalog,
): ((query: string, limit: number) => QuickHit[]) => {
  // Prepared targets are memoised by text so each keystroke only re-scores.
  const prepared = new Map<string, Prepared>();
  const prep = (s: string): Prepared => {
    let p = prepared.get(s);
    if (!p) {
      if (prepared.size >= CACHE_MAX) prepared.clear();
      p = fuzzysort.prepare(s);
      prepared.set(s, p);
    }
    return p;
  };

  return (query, limit) => {
    const q = query.trim();
    if (!q || limit <= 0) return [];
    const corpus = catalog.corpus();
    const byId = new Map(corpus.map((r) => [r.sessionId, r]));

    /**
     * The best `n` hits among the archived chats or the others. Each group
     * is ranked on its own, so neither can crowd the other out.
     */
    const best = (archived: boolean, n: number): QuickHit[] => {
      if (n <= 0) return [];
      const rows = corpus
        .filter((r) => (r.bucket === 'archived') === archived)
        .map((r) => ({ r, title: prep(r.title), project: prep(r.projectName) }));
      const hits = new Map<string, QuickHit>();
      const add = (id: string, score: number, snippet?: string): void => {
        const r = byId.get(id);
        if (!r || (r.bucket === 'archived') !== archived) return;
        const old = hits.get(id);
        if (old) {
          old.score = Math.max(old.score, score);
          if (snippet && !old.snippet) old.snippet = snippet;
          return;
        }
        hits.set(id, {
          sessionId: id,
          title: r.title,
          projectName: r.projectName,
          score,
          ...(snippet ? { snippet } : {}),
          ...(archived ? { archived: true } : {}),
        });
      };
      for (const m of fuzzysort.go(q, rows, { key: 'title', limit: n, threshold: THRESHOLD }))
        add(m.obj.r.sessionId, m.score);
      for (const m of fuzzysort.go(q, rows, { key: 'project', limit: n, threshold: THRESHOLD })) {
        add(m.obj.r.sessionId, m.score * PROJECT_WEIGHT);
      }
      for (const h of db.searchFts(q, n, archived)) add(h.sessionId, FTS_SCORE, h.snippet);
      return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, n);
    };

    // Every other match first; archived matches fill the slots left.
    const main = best(false, limit);
    return [...main, ...best(true, limit - main.length)];
  };
};
