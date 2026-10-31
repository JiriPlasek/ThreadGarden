import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The shell compares the service's version with the app's (spec §4.2, Ruling
 * R18): every part of one release must carry the same version, or a fresh
 * install would ask to restart its own service, and an old service still
 * running after an update would go unnoticed.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path: string): { version: string } => JSON.parse(read(path)) as { version: string };

describe('release versions', () => {
  it('the app, the service, the protocol and the Tauri shell carry one version (v1.2 = 0.2.0)', () => {
    const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(
      read('../src-tauri/Cargo.toml'),
    );
    const lock = /name = "pahub"\r?\nversion = "([^"]+)"/.exec(read('../src-tauri/Cargo.lock'));
    const versions = {
      root: json('../../../package.json').version,
      desktop: json('../package.json').version,
      tauri: json('../src-tauri/tauri.conf.json').version,
      cargo: cargo?.[1],
      cargoLock: lock?.[1],
      service: json('../../../packages/service/package.json').version,
      protocol: json('../../../packages/protocol/package.json').version,
    };
    expect(versions).toEqual({
      root: '0.2.0',
      desktop: '0.2.0',
      tauri: '0.2.0',
      cargo: '0.2.0',
      cargoLock: '0.2.0',
      service: '0.2.0',
      protocol: '0.2.0',
    });
  });
});
