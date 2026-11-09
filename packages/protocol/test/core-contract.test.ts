import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  methods,
  settingsDefaults,
  type MethodName,
} from '../src/index.js';

/**
 * The phone's core (Rust, `apps/desktop/src-tauri/core`) answers the screens
 * in the service's place. Its answers are written here by its contract test
 * (`THREADGARDEN_WRITE_FIXTURES=1 cargo test --test contract`), which also
 * fails when they're stale; this side checks them against the schemas, so a
 * protocol change the core doesn't follow fails here. In `hello`, the machine
 * id and the version are stand-ins, the same in every run.
 */
const dir = new URL('./fixtures/core-answers/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

type Case = { params: unknown; result?: unknown; error?: { code: string } };
type Fixture = { method: string; cases: Case[] };
type Table = {
  protocolVersion: number;
  maxRequestBytes: number;
  answered: string[];
  refused: string[];
};

const table = read('methods.json') as Table;
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'methods.json')
  .map((f) => read(f) as Fixture);
const isMethod = (m: string): m is MethodName => Object.hasOwn(methods, m);

describe('the phone core', () => {
  it('speaks this protocol version, with its frame limit', () => {
    expect(table.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(table.maxRequestBytes).toBe(MAX_REQUEST_BYTES);
  });

  it('answers or deliberately refuses every protocol method, and only those', () => {
    for (const m of [...table.answered, ...table.refused]) expect(isMethod(m), m).toBe(true);
    expect(table.answered.filter((m) => table.refused.includes(m))).toEqual([]);
    expect([...table.answered, ...table.refused].sort()).toEqual(Object.keys(methods).sort());
  });

  it('has an answer on file for every method it answers', () => {
    expect(fixtures.map((f) => f.method).sort()).toEqual([...table.answered].sort());
  });

  it.each(fixtures.map((f) => [f.method, f] as const))('%s answers as the schema says', (_, f) => {
    if (!isMethod(f.method)) throw new Error(`${f.method} is not a protocol method`);
    const def = methods[f.method];
    expect(f.cases.length).toBeGreaterThan(0);
    for (const c of f.cases) {
      // The request the core was asked is one the UI could send.
      def.params.parse(c.params);
      if (c.error) expect(c.error.code).toMatch(/^[A-Z_]+$/);
      // Parsed back unchanged: zod strips keys it doesn't know, so an extra key fails too.
      else expect(def.result.parse(c.result)).toEqual(c.result);
    }
  });

  it('answers the desktop service’s default settings', () => {
    const first = (read('settings.get.json') as Fixture).cases[0];
    expect(first?.result).toEqual(settingsDefaults);
  });

  it('says hello as a phone: protocol 11, not headless, no capabilities', () => {
    const hello = methods.hello.result.parse((read('hello.json') as Fixture).cases[0]?.result);
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.machine).toMatchObject({ headless: false, home: '', capabilities: [] });
  });
});
