/**
 * v1.2 C1, Ruling R33: the title query loads no settings (`settingSources: []`),
 * so it is skipped whenever the user, project or local settings could route a
 * session elsewhere (gateway, Bedrock/Vertex, a key helper…).
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTING_KEYS,
  RoutingSettingsCheck,
  routingSettingsPaths,
} from '../../src/chat/title-routing.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-routing-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

describe('routingSettingsPaths', () => {
  it('lists the user settings and the chat folder’s project and local settings', () => {
    expect(routingSettingsPaths('/cfg', '/work/p')).toEqual([
      join('/cfg', 'settings.json'),
      join('/work/p', '.claude', 'settings.json'),
      join('/work/p', '.claude', 'settings.local.json'),
    ]);
  });
});

describe('RoutingSettingsCheck', () => {
  it('lets a title through when no settings file exists or none routes elsewhere', async () => {
    const check = new RoutingSettingsCheck();
    const paths = routingSettingsPaths(join(dir, 'cfg'), join(dir, 'work'));
    expect(await check.check(paths)).toBeUndefined();
    await write(paths[0]!, '{"permissions":{"allow":[]},"model":"opus","env":{}}');
    expect(await check.check(paths)).toBeUndefined();
  });

  it.each(ROUTING_KEYS)('skips when a settings file sets %s', async (key) => {
    const check = new RoutingSettingsCheck();
    const paths = routingSettingsPaths(join(dir, 'cfg'), join(dir, 'work'));
    const value = key === 'env' ? { ANTHROPIC_BASE_URL: 'https://gw' } : '/bin/helper';
    await write(paths[0]!, JSON.stringify({ [key]: value }));
    expect(await check.check(paths)).toMatch(new RegExp(`sets ${key}`));
  });

  it('checks the project and local settings of the chat’s folder too', async () => {
    const check = new RoutingSettingsCheck();
    const paths = routingSettingsPaths(join(dir, 'cfg'), join(dir, 'work'));
    await write(paths[2]!, '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}');
    expect(await check.check(paths)).toMatch(/settings\.local\.json sets env/);
    await rm(paths[2]!);
    await write(paths[1]!, '{"apiKeyHelper":"x"}');
    expect(await check.check(paths)).toMatch(/settings\.json sets apiKeyHelper/);
  });

  it('treats a file that is not a JSON object as a reason to skip', async () => {
    const check = new RoutingSettingsCheck();
    const paths = routingSettingsPaths(join(dir, 'cfg'), join(dir, 'work'));
    await write(paths[0]!, '{"env": ');
    expect(await check.check(paths)).toMatch(/not valid JSON/);
    await write(paths[0]!, '[1, 2]');
    expect(await check.check(paths)).toMatch(/not valid JSON/);
    // A byte-order mark is fine.
    await write(paths[0]!, '\uFEFF{"model":"opus"}');
    expect(await check.check(paths)).toBeUndefined();
  });

  it('reads a file again only when it changed (stat only otherwise), never writing', async () => {
    const reads = vi.fn(async (p: string) =>
      (await import('node:fs/promises')).readFile(p, 'utf8'),
    );
    const check = new RoutingSettingsCheck({ readFile: reads });
    const paths = routingSettingsPaths(join(dir, 'cfg'), join(dir, 'work'));
    await write(paths[0]!, '{"model":"opus"}');
    const before = await stat(paths[0]!);
    expect(await check.check(paths)).toBeUndefined();
    expect(await check.check(paths)).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);
    await writeFile(paths[0]!, '{"env":{"HTTPS_PROXY":"http://proxy"}}');
    const later = new Date(before.mtimeMs + 5_000);
    await utimes(paths[0]!, later, later);
    expect(await check.check(paths)).toMatch(/sets env/);
    expect(reads).toHaveBeenCalledTimes(2);
    // The file was only read: its time is the one set above.
    expect((await stat(paths[0]!)).mtimeMs).toBe(later.getTime());
  });
});
