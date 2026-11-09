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
  it('the app, the service, the protocol, the Tauri shell (desktop and Android) and the phone core carry one version', () => {
    const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(
      read('../src-tauri/Cargo.toml'),
    );
    const lock = /name = "threadgarden"\r?\nversion = "([^"]+)"/.exec(
      read('../src-tauri/Cargo.lock'),
    );
    const coreInAppLock = /name = "threadgarden-core"\r?\nversion = "([^"]+)"/.exec(
      read('../src-tauri/Cargo.lock'),
    );
    const core = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(
      read('../src-tauri/core/Cargo.toml'),
    );
    const coreLock = /name = "threadgarden-core"\r?\nversion = "([^"]+)"/.exec(
      read('../src-tauri/core/Cargo.lock'),
    );
    const versions = {
      root: json('../../../package.json').version,
      desktop: json('../package.json').version,
      tauri: json('../src-tauri/tauri.conf.json').version,
      android: json('../src-tauri/tauri.android.conf.json').version,
      cargo: cargo?.[1],
      cargoLock: lock?.[1],
      core: core?.[1],
      coreLock: coreLock?.[1],
      coreInAppLock: coreInAppLock?.[1],
      service: json('../../../packages/service/package.json').version,
      protocol: json('../../../packages/protocol/package.json').version,
    };
    const root = versions.root;
    expect(versions).toEqual({
      root,
      desktop: root,
      tauri: root,
      android: root,
      cargo: root,
      cargoLock: root,
      core: root,
      coreLock: root,
      coreInAppLock: root,
      service: root,
      protocol: root,
    });
  });
});
