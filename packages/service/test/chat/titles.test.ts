/** v1.2 C1: provisional and generated chat titles (Threadgarden's own metadata). */
import { describe, expect, it } from 'vitest';
import { ChatTitles, provisionalTitle, sanitizeTitle, titlePrompt } from '../../src/chat/titles.js';
import { titleFor } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { ManualTimers } from './live-helpers.js';

describe('provisionalTitle', () => {
  it('uses a readable paste label for provisional and history fallback titles', () => {
    const text =
      '\n\n<pasted_content id="abcd">\na log\nanother line\n</pasted_content id="abcd">\n\n';
    expect(provisionalTitle(text)).toBe('[Pasted text #1 +2 lines]');
    expect(titleFor({ firstPrompt: text })).toBe('[Pasted text #1 +2 lines]');
  });
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
  it('includes the displayed title and first and recent conversation within 12000 characters', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `message-${i}:` + '\\"'.repeat(5000),
    }));
    const prompt = titlePrompt('Existing overall title', messages);
    expect(prompt.length).toBeLessThanOrEqual(12000);
    const value = JSON.parse(prompt);
    expect(value.currentTitle).toBe('Existing overall title');
    expect(value.conversation[0].text).toContain('message-0:');
    expect(value.conversation[1].text).toContain('message-1:');
    expect(value.conversation.at(-1).text).toContain('message-39:');
    expect(value.conversation.some((m: { text: string }) => m.text.startsWith('message-20:'))).toBe(
      false,
    );
    expect(value.conversation.at(-1).role).toBe('assistant');
  });
});

it('defers then names clarified context', async () => {
  const db = openDb(':memory:');
  let messages = [
    { id: '1', role: 'user' as const, text: 'Help me with this' },
    { id: '2', role: 'assistant' as const, text: 'What would you like to do?' },
  ];
  const calls: { resolve: (s: string) => void }[] = [];
  const titles = new ChatTitles({
    db,
    adapter: { oneShot: () => new Promise((resolve) => calls.push({ resolve })) },
    enabled: () => true,
    run: () => ({ claudePath: '/claude', env: {} }),
    conversation: async () => messages,
    titleChanged: () => {},
    emit: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  };
  titles.started('c', '/w', 'Help me with this');
  titles.turnEnded('c', '/w');
  await flush();
  calls[0]!.resolve('{"title":null}');
  await flush();
  expect(db.metaOf('c').generatedTitle).toBeNull();
  messages = [
    ...messages,
    { id: '3', role: 'user', text: 'Repair Safari login redirects' },
    { id: '4', role: 'assistant', text: 'I found the redirect failure' },
  ];
  titles.turnEnded('c', '/w');
  await flush();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve('{"title":"Safari login redirect repair"}');
  await flush();
  expect(db.metaOf('c').generatedTitle).toBe('Safari login redirect repair');
  const result = titles.regenerate('c', '/w');
  await flush();
  db.setCustomTitle('c', 'My manual title');
  calls[2]!.resolve('{"title":"Other title"}');
  expect(await result).toEqual({ title: 'My manual title', changed: false });
  titles.dispose();
  db.close();
});

const harness = () => {
  const db = openDb(':memory:');
  let now = 0;
  let enabled = true;
  const messages: import('../../src/chat/titles.js').TitleMessage[] = [];
  const calls: {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    options: import('../../src/sdk/adapter.js').OneShotOptions;
  }[] = [];
  const create = () =>
    new ChatTitles({
      db,
      adapter: {
        oneShot: (options) =>
          new Promise((resolve, reject) => calls.push({ resolve, reject, options })),
      },
      conversation: async () => [...messages],
      enabled: () => enabled,
      now: () => now,
      run: () => ({ claudePath: '/claude', env: {} }),
      titleChanged: () => {},
      emit: () => {},
    });
  let titles = create();
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  };
  const exchange = (text = 'Investigate the Safari login redirect failure') => {
    messages.push(
      { id: String(messages.length), role: 'user', text },
      {
        id: String(messages.length + 1),
        role: 'assistant',
        text: 'Investigated the redirect implementation',
      },
    );
  };
  return {
    db,
    calls,
    messages,
    exchange,
    flush,
    get titles() {
      return titles;
    },
    end: async () => {
      titles.turnEnded('c', '/w');
      await flush();
    },
    answer: async (title: string | null) => {
      calls.at(-1)!.resolve(JSON.stringify({ title }));
      await flush();
    },
    restart: () => {
      titles.dispose();
      titles = create();
    },
    advance: () => {
      now += 30 * 60 * 1000;
    },
    disable: () => {
      enabled = false;
    },
    close: () => {
      titles.dispose();
      db.close();
    },
  };
};
it('persists checkpoints across restart and respects early refinement and cooldown', async () => {
  const h = harness();
  try {
    h.titles.started('c', '/w', 'Repair login');
    h.exchange();
    await h.end();
    await h.answer('Safari login repair');
    h.restart();
    await h.end();
    expect(h.calls).toHaveLength(1);
    h.exchange('Repair redirect cookie handling');
    await h.end();
    await h.answer('Safari cookie repair');
    h.exchange('Test redirect cookie persistence');
    await h.end();
    await h.answer(null);
    for (let i = 0; i < 5; i++) h.exchange();
    await h.end();
    expect(h.calls).toHaveLength(3);
    h.advance();
    await h.end();
    expect(h.calls).toHaveLength(4);
    await h.answer(null);
    expect(h.db.metaOf('c').generatedTitle).toBe('Safari cookie repair');
  } finally {
    h.close();
  }
});
it('allows explicit regeneration of old custom chats with automatic naming disabled', async () => {
  const h = harness();
  try {
    h.disable();
    h.db.setCustomTitle('c', 'My old title');
    h.exchange();
    await h.end();
    expect(h.calls).toHaveLength(0);
    const result = h.titles.regenerate('c', '/w');
    await h.flush();
    await h.answer('Safari login repair');
    expect(await result).toEqual({ title: 'Safari login repair', changed: true });
    expect(h.db.metaOf('c').customTitle).toBeNull();
  } finally {
    h.close();
  }
});
it('retries a failed attempt on new context and rejects a stale response', async () => {
  const h = harness();
  try {
    h.titles.started('c', '/w', 'Repair login');
    h.exchange();
    await h.end();
    h.calls[0]!.reject(new Error('overloaded'));
    await h.flush();
    expect(h.db.titleCheck('c')).toBeUndefined();
    h.exchange('Investigate cookie handling');
    await h.end();
    h.exchange('Actually fix Firefox redirects');
    await h.answer('Stale Safari title');
    expect(h.db.metaOf('c').generatedTitle).toBeNull();
    await h.end();
    await h.answer('Firefox redirect repair');
    expect(h.db.metaOf('c').generatedTitle).toBe('Firefox redirect repair');
  } finally {
    h.close();
  }
});
it('locks automatic naming after a manual title and excludes acknowledgement turns', async () => {
  const h = harness();
  try {
    h.titles.started('c', '/w', 'Repair login');
    h.exchange();
    await h.end();
    await h.answer(null);
    h.messages.push(
      { id: 'ack', role: 'user', text: 'thanks' },
      { id: 'reply', role: 'assistant', text: 'You are welcome' },
    );
    await h.end();
    expect(h.calls).toHaveLength(1);
    h.db.setCustomTitle('c', 'My title');
    h.exchange();
    await h.end();
    expect(h.calls).toHaveLength(1);
  } finally {
    h.close();
  }
});
it('serializes each chat and limits provider calls globally to two', async () => {
  const h = harness();
  try {
    h.exchange();
    for (const id of ['a', 'b', 'c']) h.titles.started(id, '/w', 'Repair login');
    h.titles.turnEnded('a', '/w');
    h.titles.turnEnded('a', '/w');
    h.titles.turnEnded('b', '/w');
    h.titles.turnEnded('c', '/w');
    await h.flush();
    expect(h.calls).toHaveLength(2);
    h.calls[0]!.resolve('{"title":null}');
    await h.flush();
    expect(h.calls).toHaveLength(3);
    h.calls[1]!.resolve('{"title":null}');
    h.calls[2]!.resolve('{"title":null}');
    await h.flush();
    expect(h.calls).toHaveLength(3);
  } finally {
    h.close();
  }
});

it('retains native Codex dispatch and tracks query ghost sessions', async () => {
  const h = harness();
  try {
    h.exchange();
    h.titles.started('codex-00000000-0000-0000-0000-000000000001', '/w', 'Repair login');
    h.titles.turnEnded('codex-00000000-0000-0000-0000-000000000001', '/w');
    await h.flush();
    const options = h.calls[0]!.options;
    expect(options.model).toBe('codex:default');
    expect(options.sourceSessionId).toBe('codex-00000000-0000-0000-0000-000000000001');
    expect(h.titles.runningIds()).toContain(options.sessionId);
    h.calls[0]!.resolve('{"title":"Safari login repair"}');
    await h.flush();
    expect(h.titles.runningIds()).toContain(options.sessionId);
    h.advance();
    expect(h.titles.runningIds()).toEqual([]);
  } finally {
    h.close();
  }
});
it('aborts provider queries on shutdown without applying late titles', async () => {
  const h = harness();
  try {
    h.exchange();
    h.titles.started('c', '/w', 'Repair login');
    await h.end();
    h.titles.dispose();
    expect(h.calls[0]!.options.signal.aborted).toBe(true);
    h.calls[0]!.resolve('{"title":"Late title"}');
    await h.flush();
    expect(h.db.metaOf('c').generatedTitle).toBeNull();
  } finally {
    h.close();
  }
});
it('rejects malformed manual results and preserves the old custom title', async () => {
  const h = harness();
  try {
    h.exchange();
    h.db.setCustomTitle('c', 'Custom title');
    const promise = h.titles.regenerate('c', '/w');
    const failure = expect(promise).rejects.toThrow('Invalid title response');
    await h.flush();
    h.calls[0]!.resolve('untrusted raw model output');
    await failure;
    expect(h.db.metaOf('c').customTitle).toBe('Custom title');
  } finally {
    h.close();
  }
});

it('protects a manual title changed A to B and back to A while generating', async () => {
  const h = harness();
  try {
    h.exchange();
    h.db.setCustomTitle('c', 'A');
    const result = h.titles.regenerate('c', '/w');
    await h.flush();
    h.db.setCustomTitle('c', 'B');
    h.db.setCustomTitle('c', 'A');
    await h.answer('Generated title');
    expect(await result).toEqual({ title: 'A', changed: false });
    expect(h.db.metaOf('c').customTitle).toBe('A');
  } finally {
    h.close();
  }
});
it('releases hung context slots after timeout and disposal', async () => {
  const db = openDb(':memory:');
  const timers = new ManualTimers();
  let reads = 0;
  const titles = new ChatTitles({
    db,
    adapter: { oneShot: async () => '{"title":null}' },
    enabled: () => true,
    run: () => ({ claudePath: '/claude', env: {} }),
    conversation: () => {
      reads++;
      return new Promise(() => {});
    },
    titleChanged: () => {},
    emit: () => {},
    timers,
    now: timers.now,
  });
  try {
    for (const id of ['a', 'b', 'c']) {
      titles.started(id, '/w', 'Repair login');
      titles.turnEnded(id, '/w');
    }
    await new Promise<void>((r) => setImmediate(r));
    expect(reads).toBe(2);
    timers.advance(20000);
    await new Promise<void>((r) => setImmediate(r));
    expect(reads).toBe(3);
    const result = titles.regenerate('manual', '/w');
    const rejected = expect(result).rejects.toThrow();
    await new Promise<void>((r) => setImmediate(r));
    titles.dispose();
    await rejected;
  } finally {
    titles.dispose();
    db.close();
  }
});
it('does not spend established cooldown quota on a failed provider attempt', async () => {
  const h = harness();
  try {
    h.titles.started('c', '/w', 'Repair login');
    h.exchange();
    await h.end();
    await h.answer('Login repair');
    h.exchange();
    await h.end();
    await h.answer(null);
    h.exchange();
    await h.end();
    await h.answer(null);
    for (let i = 0; i < 5; i++) h.exchange();
    h.advance();
    await h.end();
    h.calls.at(-1)!.reject(new Error('provider failed'));
    await h.flush();
    expect(h.db.titleCheck('c')?.userCount).toBe(3);
    await h.end();
    expect(h.calls).toHaveLength(5);
    await h.answer(null);
    expect(h.db.titleCheck('c')?.userCount).toBe(8);
  } finally {
    h.close();
  }
});

it('times out hung routing and never starts a provider after a forgotten request', async () => {
  const db = openDb(':memory:');
  const timers = new ManualTimers();
  let routeResolve: (value: undefined) => void = () => {};
  let calls = 0;
  const titles = new ChatTitles({
    db,
    adapter: {
      oneShot: async () => {
        calls++;
        return '{"title":null}';
      },
    },
    enabled: () => true,
    run: () => ({ claudePath: '/claude', env: {} }),
    conversation: async () => [
      { id: 'u', role: 'user', text: 'Repair Safari login' },
      { id: 'a', role: 'assistant', text: 'Investigating the redirect' },
    ],
    routedElsewhere: () =>
      new Promise((resolve) => {
        routeResolve = resolve;
      }),
    titleChanged: () => {},
    emit: () => {},
    timers,
    now: timers.now,
  });
  try {
    const result = titles.regenerate('c', '/w');
    const failure = expect(result).rejects.toThrow('timed out');
    await new Promise<void>((r) => setImmediate(r));
    timers.advance(20000);
    await failure;
    expect(db.titleCheck('c')).toBeUndefined();
    const forgotten = titles.regenerate('c', '/w');
    const rejected = expect(forgotten).rejects.toThrow('ended');
    await new Promise<void>((r) => setImmediate(r));
    titles.forget('c');
    await rejected;
    routeResolve(undefined);
    await new Promise<void>((r) => setImmediate(r));
    expect(calls).toBe(0);
  } finally {
    titles.dispose();
    db.close();
  }
});
it('aborts a final freshness read without applying a title or checkpoint', async () => {
  const db = openDb(':memory:');
  let reads = 0;
  let resolveRead: (v: import('../../src/chat/titles.js').TitleMessage[]) => void = () => {};
  const messages: import('../../src/chat/titles.js').TitleMessage[] = [
    { id: 'u', role: 'user', text: 'Repair login' },
    { id: 'a', role: 'assistant', text: 'Investigating login' },
  ];
  const titles = new ChatTitles({
    db,
    adapter: { oneShot: async () => '{"title":"Login repair"}' },
    enabled: () => true,
    run: () => ({ claudePath: '/claude', env: {} }),
    conversation: async () =>
      ++reads === 1
        ? messages
        : await new Promise((resolve) => {
            resolveRead = resolve;
          }),
    titleChanged: () => {},
    emit: () => {},
  });
  try {
    const result = titles.regenerate('c', '/w');
    const rejected = expect(result).rejects.toThrow('stopped');
    await new Promise<void>((r) => setImmediate(r));
    expect(reads).toBe(2);
    titles.dispose();
    await rejected;
    resolveRead(messages);
    await new Promise<void>((r) => setImmediate(r));
    expect(db.titleCheck('c')).toBeUndefined();
    expect(db.metaOf('c').generatedTitle).toBeNull();
  } finally {
    titles.dispose();
    db.close();
  }
});
