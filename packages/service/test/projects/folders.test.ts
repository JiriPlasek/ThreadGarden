import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeFolder, listFolders, makeFolder, validName } from '../../src/projects/folders.js';

let tmp: string;
let code: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'threadgarden-folders-'));
  code = path.join(tmp, 'code');
  mkdirSync(path.join(code, 'alpha', '.git'), { recursive: true });
  mkdirSync(path.join(code, 'beta'));
  mkdirSync(path.join(code, '.hidden'));
  writeFileSync(path.join(tmp, 'file.txt'), '');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
};

describe('listFolders', () => {
  it('lists only visible folders with git marks', async () => {
    const listing = await listFolders(code);
    expect(listing.path).toBe(code);
    expect(listing.parent).toBe(tmp);
    expect(listing.folders).toEqual([
      { name: 'alpha', path: path.join(code, 'alpha'), git: true },
      { name: 'beta', path: path.join(code, 'beta'), git: false },
    ]);
  });

  it('~ means the home folder', async () => {
    const listing = await listFolders('~/code', tmp);
    expect(listing.path).toBe(code);
    expect(listing.folders.map((f) => f.name)).toEqual(['alpha', 'beta']);
  });

  it('normalizes the path it was given', async () => {
    const dotted = await listFolders(path.join(code, '..', 'code'));
    expect(dotted.path).toBe(code);
    expect(dotted.parent).toBe(tmp);
    const up = await listFolders(path.join(code, '..'));
    expect(up.path).toBe(tmp);
    expect(up.parent).toBe(path.dirname(tmp));
    expect((await listFolders(code + path.sep)).path).toBe(code);
  });

  it('a relative path is refused', async () => {
    await expect(listFolders('code/alpha', tmp)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Type a full path, or start with ~',
    });
  });

  it('missing, file, and the root', async () => {
    expect(await codeOf(() => listFolders(path.join(tmp, 'nope')))).toBe('NOT_FOUND');
    expect(await codeOf(() => listFolders(path.join(tmp, 'file.txt')))).toBe('NOT_A_FOLDER');
    expect((await listFolders(path.parse(tmp).root)).parent).toBeNull();
  });
});

describe('completeFolder', () => {
  it('completes by prefix and lists children after a separator', async () => {
    expect(await completeFolder(path.join(code, 'al'))).toEqual([path.join(code, 'alpha')]);
    expect(await completeFolder(code + path.sep)).toEqual([
      path.join(code, 'alpha'),
      path.join(code, 'beta'),
    ]);
    expect(await completeFolder(path.join(code, '.h'))).toEqual([path.join(code, '.hidden')]);
  });

  it('keeps the trailing separator through ~', async () => {
    expect(await completeFolder('~/', tmp)).toEqual([code]);
    expect(await completeFolder('~/code/', tmp)).toEqual([
      path.join(code, 'alpha'),
      path.join(code, 'beta'),
    ]);
    if (path.sep === '\\') expect(await completeFolder('~\\', tmp)).toEqual([code]);
  });
});

describe('makeFolder', () => {
  it('refuses bad names and existing folders, and makes one level', async () => {
    for (const bad of ['../x', 'a/b', '..', '']) {
      expect(await codeOf(() => makeFolder(code, bad))).toBe('INVALID_NAME');
    }
    expect(await codeOf(() => makeFolder(code, 'beta'))).toBe('EXISTS');
    expect(await makeFolder(code, 'gamma')).toBe(path.join(code, 'gamma'));
    expect(existsSync(path.join(code, 'gamma'))).toBe(true);
    expect(await codeOf(() => makeFolder(path.join(tmp, 'nope'), 'x'))).toBe('NOT_FOUND');
  });
});

describe('validName', () => {
  it('follows the protocol rule: no trailing dot on any platform', () => {
    expect(validName('plant', 'linux')).toBe(true);
    expect(validName('plant.', 'linux')).toBe(false);
    expect(validName('...', 'linux')).toBe(false);
  });

  it('refuses Windows device names there, with or without an extension', () => {
    for (const name of ['nul', 'CON', 'Con.txt', 'com1.md', 'LPT9', 'prn', 'aux.tar.gz']) {
      expect(validName(name, 'win32')).toBe(false);
      expect(validName(name, 'linux')).toBe(true);
    }
    for (const name of ['console', 'com10', 'lpt0', 'nul-x', 'auxiliary.md']) {
      expect(validName(name, 'win32')).toBe(true);
    }
  });
});
