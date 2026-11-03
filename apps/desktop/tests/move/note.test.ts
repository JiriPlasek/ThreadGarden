import { describe, expect, it } from 'vitest';
import { isThreadgardenNote, moveNote } from '../../src/lib/move/note';

const base = {
  from: 'This PC',
  to: 'kumbal-machine',
  folder: '/home/k/code/threadgarden',
  origin: 'git@github.com:acme/threadgarden.git',
  branch: 'fix/usage',
  leftBehind: null,
  inUse: false,
};

describe('moveNote', () => {
  it('first line names both machines', () => {
    expect(moveNote(base).split('\n')[0]).toBe(
      '[Threadgarden] This chat moved from This PC to kumbal-machine.',
    );
  });

  it('includes folder, origin and branch', () => {
    const note = moveNote(base);
    expect(note).toContain('/home/k/code/threadgarden');
    expect(note).toContain('git@github.com:acme/threadgarden.git');
    expect(note).toContain('fix/usage');
  });

  it('tells Claude to clone if missing and to check out the branch', () => {
    const note = moveNote(base);
    expect(note).toMatch(/clone/i);
    expect(note).toMatch(/missing/i);
    expect(note).toMatch(/fetch/i);
    expect(note).toMatch(/check out/i);
  });

  it('includes the never-stash rule', () => {
    const note = moveNote(base);
    expect(note).toMatch(/never stash, reset, overwrite or switch/i);
    expect(note).toMatch(/uncommitted changes/i);
    expect(note).toMatch(/stop and ask/i);
  });

  it('with leftBehind says what stayed and where', () => {
    const note = moveNote({
      ...base,
      leftBehind: '3 changed files · 2 commits not pushed on fix/usage',
    });
    expect(note).toContain('3 changed files · 2 commits not pushed on fix/usage');
    expect(note).toContain('stayed on This PC');
  });

  it('without leftBehind says nothing stayed behind', () => {
    expect(moveNote(base)).not.toMatch(/stayed on This PC/);
  });

  it('with no origin says the files stayed', () => {
    const note = moveNote({ ...base, origin: null, branch: null });
    expect(note).toContain('this folder is not a git repo; its files stayed on This PC');
    expect(note).not.toMatch(/fetch/i);
  });

  it('inUse says to stop and ask, not switch, and never make a worktree', () => {
    const note = moveNote({ ...base, inUse: true });
    expect(note).toMatch(/other chats/i);
    expect(note).toMatch(/do not switch branches/i);
    expect(note).toMatch(/worktree/i);
    expect(moveNote(base)).not.toMatch(/worktree/i);
  });
});

describe('isThreadgardenNote', () => {
  it('true only for the prefix', () => {
    expect(isThreadgardenNote('[Threadgarden] This chat moved from A to B.')).toBe(true);
    expect(isThreadgardenNote('hello [Threadgarden] ')).toBe(false);
    expect(isThreadgardenNote('[Threadgarden]no space')).toBe(false);
  });
});
