/** v1.2 C1: provisional and generated chat titles (Threadgarden's own metadata). */
import type { EventMsg } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChatTitles,
  TITLE_CONCURRENCY,
  TITLE_GHOST_GRACE_MS,
  TITLE_INPUT_MAX,
  TITLE_MODEL,
  TITLE_SYSTEM_PROMPT,
  TITLE_TIMEOUT_MS,
  provisionalTitle,
  sanitizeTitle,
  titlePrompt,
  type TitleRun,
} from '../../src/chat/titles.js';
import { titleFor } from '../../src/history/catalog.js';
import { openDb, type Db } from '../../src/history/db.js';
import type { OneShotOptions } from '../../src/sdk/adapter.js';
import { ManualTimers } from './live-helpers.js';

describe('provisionalTitle', () => {
  it('is the first sentence of the first line, whitespace collapsed', () => {
    expect(provisionalTitle('Fix the login bug on Safari. It fails after the redirect.')).toBe(
      'Fix the login bug on Safari.',
    );
    expect(provisionalTitle('  Refactor   the\tparser module\nso that it streams\n')).toBe(
      'Refactor the parser module',
    );
    expect(provisionalTitle('\n\n  Second line wins when the first is blank')).toBe(
      'Second line wins when the first is blank',
    );
  });

  it('keeps a very short first sentence together with the rest of its line', () => {
    expect(provisionalTitle('Hi! Can you look at the failing tests?')).toBe(
      'Hi! Can you look at the failing tests?',
    );
  });

  it('does not cut at common abbreviations', () => {
    expect(provisionalTitle('Please refactor the parser, e.g. the lexer part. Then test.')).toBe(
      'Please refactor the parser, e.g. the lexer part.',
    );
    expect(provisionalTitle('Compare the old parser vs. the new one. Thanks')).toBe(
      'Compare the old parser vs. the new one.',
    );
    expect(provisionalTitle('Clean up logs, caches etc. in the build folder')).toBe(
      'Clean up logs, caches etc. in the build folder',
    );
    expect(provisionalTitle('Use the fast path, i.e. skip the cache. Then measure.')).toBe(
      'Use the fast path, i.e. skip the cache.',
    );
  });

  it('does not split at dots inside words, paths or versions', () => {
    expect(provisionalTitle('Update src/app.ts to v1.2 and bump package.json')).toBe(
      'Update src/app.ts to v1.2 and bump package.json',
    );
  });

  it('keeps slash commands and @mentions as typed', () => {
    expect(provisionalTitle('/review the auth module')).toBe('/review the auth module');
    expect(provisionalTitle('/compact')).toBe('/compact');
    expect(provisionalTitle('Explain @src/lib/db.ts please')).toBe('Explain @src/lib/db.ts please');
  });

  it('is cut to 80 characters like every non-custom title', () => {
    const long = 'word '.repeat(60);
    const t = provisionalTitle(long);
    expect(t.length).toBeLessThanOrEqual(80);
    // titleFor's cut, without the trailing space a cut can leave.
    expect(t).toBe(titleFor({ firstPrompt: long }).trim());
  });

  it('is empty for a message without text (images only)', () => {
    expect(provisionalTitle('')).toBe('');
    expect(provisionalTitle('  \n\t ')).toBe('');
  });
});

describe('sanitizeTitle', () => {
  it('strips quotes, markdown, a "Title:" label and end punctuation', () => {
    expect(sanitizeTitle('"Fix Safari login redirect"')).toBe('Fix Safari login redirect');
    expect(sanitizeTitle('“Fix Safari login redirect.”')).toBe('Fix Safari login redirect');
    expect(sanitizeTitle('**Fix Safari login redirect**')).toBe('Fix Safari login redirect');
    expect(sanitizeTitle('# Fix Safari login redirect!')).toBe('Fix Safari login redirect');
    expect(sanitizeTitle('Title: `Parser` streaming refactor.')).toBe('Parser streaming refactor');
    expect(sanitizeTitle("'Parser streaming refactor'.")).toBe('Parser streaming refactor');
  });

  it('keeps the first non-empty line only', () => {
    expect(sanitizeTitle('\n\nParser streaming refactor\nThis title describes…')).toBe(
      'Parser streaming refactor',
    );
    expect(sanitizeTitle('Title:\nParser streaming refactor')).toBe('Parser streaming refactor');
  });

  it('keeps identifiers intact', () => {
    expect(sanitizeTitle('Fix parse_args in cli.py')).toBe('Fix parse_args in cli.py');
    expect(sanitizeTitle('Fix __init__ loading')).toBe('Fix __init__ loading');
    expect(sanitizeTitle('__Fix init loading__')).toBe('Fix init loading');
    expect(sanitizeTitle('_Fix init loading_')).toBe('Fix init loading');
  });

  it('rejects chatter: an answer of more than 10 words is no title', () => {
    expect(
      sanitizeTitle('Here is a short title for this conversation about the Safari login bug'),
    ).toBe('');
    expect(sanitizeTitle('One two three four five six seven eight nine ten')).toBe(
      'One two three four five six seven eight nine ten',
    );
  });

  it('collapses whitespace and cuts to 80 characters', () => {
    expect(sanitizeTitle('Fix   the\tparser')).toBe('Fix the parser');
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(80);
  });

  it('is empty when nothing usable is left', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('  "" ... ')).toBe('');
  });
});

describe('titlePrompt', () => {
  it('holds the first message and the start of the reply, at most 2,000 characters', () => {
    const p = titlePrompt('Fix the login bug', 'Sure, let me look at the auth module.');
    expect(p).toContain('Fix the login bug');
    expect(p).toContain('Sure, let me look at the auth module.');
    const long = titlePrompt('u'.repeat(5000), 'a'.repeat(5000));
    expect(long.length).toBeLessThanOrEqual(TITLE_INPUT_MAX);
    // Both parts are represented even when the message alone is too long.
    expect(long).toContain('uuuu');
    expect(long).toContain('aaaa');
  });

  it('works with only one of the two, and is empty with neither', () => {
    expect(titlePrompt('', 'Here is the image description')).toContain('image description');
    expect(titlePrompt('Only a question', '')).toContain('Only a question');
    expect(titlePrompt('  ', '\n')).toBe('');
  });
});

// ── ChatTitles ──────────────────────────────────────────────────────────────

type Call = {
  o: OneShotOptions;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
};

/** One-shot calls the test answers by hand. */
class Model {
  readonly calls: Call[] = [];
  oneShot = (o: OneShotOptions): Promise<string> =>
    new Promise<string>((resolve, reject) => this.calls.push({ o, resolve, reject }));
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

let db: Db;
let model: Model;
let timers: ManualTimers;
let events: EventMsg[];
let enabled: boolean;
let run: TitleRun | undefined;
let replies: Map<string, string>;
let debug: string[];
let routed: string | undefined;
let titles: ChatTitles;

beforeEach(() => {
  db = openDb(':memory:');
  model = new Model();
  timers = new ManualTimers();
  events = [];
  enabled = true;
  run = { claudePath: '/bin/claude', env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' } };
  replies = new Map();
  debug = [];
  routed = undefined;
  titles = new ChatTitles({
    db,
    adapter: model,
    enabled: () => enabled,
    run: () => run,
    firstReply: (id) => replies.get(id) ?? '',
    titleChanged: () => {},
    emit: (e) => events.push(e),
    debug: (m) => debug.push(m),
    routedElsewhere: async () => routed,
    timers,
    now: timers.now,
  });
});
afterEach(() => {
  titles.dispose();
  db.close();
});

const titleOf = (id: string) => titleFor({ ...db.metaOf(id), ...db.getSession(id) });

describe('ChatTitles', () => {
  it('sets the provisional title at once when Threadgarden starts a chat', () => {
    expect(titles.started('c1', '/w', 'Fix the login bug. It fails on Safari.')).toBe(true);
    expect(db.metaOf('c1').autoTitle).toBe('Fix the login bug.');
    expect(titleOf('c1')).toBe('Fix the login bug.');
    // Nothing is generated before the first turn ends.
    expect(model.calls).toHaveLength(0);
  });

  it('a first message without text sets no provisional title', () => {
    expect(titles.started('c1', '/w', '')).toBe(false);
    expect(db.metaOf('c1').autoTitle).toBeNull();
  });

  it('startedIfUntitled only touches chats without any title', () => {
    db.upsertSession(
      { sessionId: 'named', summary: 'Claude Code title', lastModified: 1, firstPrompt: 'hello' },
      'p',
    );
    expect(titles.startedIfUntitled('named', '/w', 'A new message')).toBe(false);
    expect(db.metaOf('named').autoTitle).toBeNull();
    // No row and no Threadgarden title: untitled.
    expect(titles.startedIfUntitled('bare', '/w', 'Continue the migration work')).toBe(true);
    expect(db.metaOf('bare').autoTitle).toBe('Continue the migration work');
    // Now it has one: a later message changes nothing.
    expect(titles.startedIfUntitled('bare', '/w', 'Something else')).toBe(false);
    expect(db.metaOf('bare').autoTitle).toBe('Continue the migration work');
  });

  it('generates a title after the first turn with the documented request', async () => {
    titles.started('c1', '/work/proj', 'Fix the login bug on Safari');
    replies.set('c1', 'Let me look at the redirect handling in auth.ts.');
    titles.turnEnded('c1');
    await flush();
    expect(model.calls).toHaveLength(1);
    const o = model.calls[0]!.o;
    expect(o).toMatchObject({
      model: TITLE_MODEL,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      cwd: '/work/proj',
      claudePath: '/bin/claude',
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' },
    });
    expect(TITLE_MODEL).toBe('haiku');
    expect(o.prompt).toContain('Fix the login bug on Safari');
    expect(o.prompt).toContain('redirect handling');
    expect(o.signal.aborted).toBe(false);

    model.calls[0]!.resolve('"Safari login redirect fix."\n');
    await flush();
    expect(db.metaOf('c1').generatedTitle).toBe('Safari login redirect fix');
    expect(titleOf('c1')).toBe('Safari login redirect fix');
    expect(events).toEqual([{ event: 'sessions.changed', data: { sessionIds: ['c1'] } }]);
  });

  it('a failure keeps the provisional title silently (debug log only)', async () => {
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    await flush();
    model.calls[0]!.reject(new Error('model overloaded'));
    await flush();
    expect(db.metaOf('c1').generatedTitle).toBeNull();
    expect(titleOf('c1')).toBe('Fix the login bug');
    expect(events).toEqual([]);
    expect(debug.join('\n')).toMatch(/model overloaded/);
  });

  it('an unusable answer counts as a failure', async () => {
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    await flush();
    model.calls[0]!.resolve('  "" ');
    await flush();
    expect(db.metaOf('c1').generatedTitle).toBeNull();
    expect(events).toEqual([]);
  });

  it('gives up after 20 s and aborts the query', async () => {
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    await flush();
    const call = model.calls[0]!;
    timers.advance(TITLE_TIMEOUT_MS - 1);
    await flush();
    expect(call.o.signal.aborted).toBe(false);
    timers.advance(1);
    await flush();
    expect(call.o.signal.aborted).toBe(true);
    expect(debug.join('\n')).toMatch(/timed out/);
    // A late answer is ignored.
    call.resolve('Too late title');
    await flush();
    expect(db.metaOf('c1').generatedTitle).toBeNull();
    expect(events).toEqual([]);
  });

  it('generates at most once per chat', async () => {
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    titles.turnEnded('c1');
    await flush();
    model.calls[0]!.reject(new Error('nope'));
    await flush();
    // Started again (e.g. an untitled-chat path) and another turn: still no second try.
    titles.started('c1', '/w', 'Fix the login bug again');
    titles.turnEnded('c1');
    await flush();
    expect(model.calls).toHaveLength(1);
  });

  it('only chats Threadgarden started are titled', async () => {
    titles.turnEnded('history-chat');
    await flush();
    expect(model.calls).toHaveLength(0);
  });

  it('does nothing when the setting is off', async () => {
    enabled = false;
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    await flush();
    expect(model.calls).toHaveLength(0);
    expect(titleOf('c1')).toBe('Fix the login bug');
  });

  it('skips when Claude Code cannot run (missing, or an API key is required and not set)', async () => {
    run = undefined;
    titles.started('c1', '/w', 'Fix the login bug');
    titles.turnEnded('c1');
    await flush();
    expect(model.calls).toHaveLength(0);
    expect(db.metaOf('c1').generatedTitle).toBeNull();
  });

  it('skips a chat the user renamed meanwhile', async () => {
    titles.started('c1', '/w', 'Fix the login bug');
    db.setCustomTitle('c1', 'My name for it');
    titles.turnEnded('c1');
    await flush();
    expect(model.calls).toHaveLength(0);
  });

  it(`runs at most ${TITLE_CONCURRENCY} generations at a time`, async () => {
    expect(TITLE_CONCURRENCY).toBe(2);
    for (const id of ['a', 'b', 'c', 'd']) {
      titles.started(id, '/w', `Message for ${id}`);
      titles.turnEnded(id);
    }
    await flush();
    expect(model.calls.map((c) => c.o.prompt.includes('Message for a'))).toEqual([true, false]);
    expect(model.calls).toHaveLength(2);
    model.calls[0]!.resolve('Title A');
    await flush();
    expect(model.calls).toHaveLength(3);
    model.calls[1]!.reject(new Error('fail B'));
    await flush();
    expect(model.calls).toHaveLength(4);
    model.calls[2]!.resolve('Title C');
    model.calls[3]!.resolve('Title D');
    await flush();
    expect(['a', 'b', 'c', 'd'].map((id) => db.metaOf(id).generatedTitle)).toEqual([
      'Title A',
      null,
      'Title C',
      'Title D',
    ]);
  });

  it('dispose aborts running generations and drops queued ones', async () => {
    for (const id of ['a', 'b', 'c']) {
      titles.started(id, '/w', `Message for ${id}`);
      titles.turnEnded(id);
    }
    await flush();
    titles.dispose();
    await flush();
    expect(model.calls.every((c) => c.o.signal.aborted)).toBe(true);
    expect(model.calls).toHaveLength(2);
    model.calls[0]!.resolve('Late');
    await flush();
    expect(db.metaOf('a').generatedTitle).toBeNull();
  });

  // ── fix round 1 ──

  it('R33: skips when settings could route sessions elsewhere, logging the reason once', async () => {
    routed = '/cfg/settings.json sets env';
    for (const id of ['a', 'b']) {
      titles.started(id, '/w', `Message for ${id}`);
      titles.turnEnded(id);
    }
    await flush();
    expect(model.calls).toHaveLength(0);
    expect(db.metaOf('a').autoTitle).toBe('Message for a');
    expect(debug.filter((m) => m.includes('sets env'))).toHaveLength(1);
  });

  it('gives each one-shot a fresh session id, listed in runningIds while it runs', async () => {
    titles.started('a', '/w', 'Message for a');
    titles.started('b', '/w', 'Message for b');
    expect(titles.runningIds()).toEqual([]);
    titles.turnEnded('a');
    titles.turnEnded('b');
    await flush();
    const ids = model.calls.map((c) => c.o.sessionId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('a');
    expect(titles.runningIds().sort()).toEqual([...ids].sort());
    model.calls[0]!.resolve('Title A');
    model.calls[1]!.reject(new Error('fail'));
    await flush();
    // Kept while their processes may still exit (fix round 2), then gone.
    timers.advance(TITLE_GHOST_GRACE_MS);
    expect(titles.runningIds()).toEqual([]);
  });

  it('forget drops a chat whose session ended before its first turn did', async () => {
    titles.started('a', '/w', 'Message for a');
    titles.forget('a');
    titles.turnEnded('a');
    await flush();
    expect(model.calls).toHaveLength(0);
    // The provisional title stays.
    expect(db.metaOf('a').autoTitle).toBe('Message for a');
  });

  // ── fix round 2 ──

  it(`keeps a finished query's id in runningIds for ${TITLE_GHOST_GRACE_MS} ms (its process is still exiting)`, async () => {
    expect(TITLE_GHOST_GRACE_MS).toBe(15_000);
    titles.started('a', '/w', 'Message for a');
    titles.started('b', '/w', 'Message for b');
    titles.turnEnded('a');
    titles.turnEnded('b');
    await flush();
    const [ida, idb] = model.calls.map((c) => c.o.sessionId) as [string, string];
    model.calls[0]!.resolve('Title A');
    await flush();
    timers.advance(10_000);
    model.calls[1]!.reject(new Error('fail'));
    await flush();
    // Both settled; both processes may still be listed by `claude agents`.
    expect(titles.runningIds().sort()).toEqual([ida, idb].sort());
    timers.advance(TITLE_GHOST_GRACE_MS - 10_000);
    expect(titles.runningIds()).toEqual([idb]);
    timers.advance(10_000);
    expect(titles.runningIds()).toEqual([]);
  });
});
