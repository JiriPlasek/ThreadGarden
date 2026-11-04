import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  PROJECTS_CAPABILITY,
  ProjectNameSchema,
  REMOTE_PROTOCOL_RANGE,
  PROTOCOL_VERSION,
  methods,
} from '../src/index.js';

describe('ProjectNameSchema', () => {
  it.each(['plant-logger', 'a.b_c-1', 'a.b', '.env', 'a'.repeat(100)])('accepts %s', (name) => {
    expect(ProjectNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(['.', '..', 'a/b', 'a b', 'C:\\x', '../x', '', 'a'.repeat(101)])('rejects %j', (name) => {
    expect(ProjectNameSchema.safeParse(name).success).toBe(false);
  });

  // Windows drops a trailing dot, so `plant.` would name the existing `plant`.
  it.each(['plant.', '...', 'a.'])('rejects the trailing dot in %j', (name) => {
    expect(ProjectNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('projects.clone', () => {
  const r = methods['projects.clone'].result;
  const job = { jobId: 'j', state: 'running', repo: 'a/b', path: '/x/b', error: null };

  it('parses both result branches', () => {
    expect(r.safeParse({ status: 'started', job }).success).toBe(true);
    expect(r.safeParse({ status: 'existing', path: '/x/b' }).success).toBe(true);
    expect(r.safeParse({ status: 'other' }).success).toBe(false);
  });

  it('only takes owner/name repos', () => {
    const p = methods['projects.clone'].params;
    expect(p.safeParse({ createIn: '/x', repo: 'a/b' }).success).toBe(true);
    expect(p.safeParse({ createIn: '/x', repo: 'a' }).success).toBe(false);
    expect(p.safeParse({ createIn: '/x', repo: 'a/b/c' }).success).toBe(false);
  });
});

describe('protocol 7', () => {
  it('is at least version 7, with the projects capability', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
    expect(REMOTE_PROTOCOL_RANGE.min).toBeLessThanOrEqual(9);
    expect(PROJECTS_CAPABILITY).toBe('projects');
    expect(CAPABILITIES).toContain('projects');
    expect(CAPABILITIES).toContain('remote');
  });
});
