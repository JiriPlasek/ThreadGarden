import { expect, it } from 'vitest';
import { methods } from '../src/index.js';

it('regenerates a history title using only its session id and reports an unchanged title', () => {
  expect(methods['chat.regenerateTitle'].params.parse({ sessionId: 'old-history' })).toEqual({
    sessionId: 'old-history',
  });
  expect(
    methods['chat.regenerateTitle'].result.parse({ title: 'Existing name', changed: false }),
  ).toEqual({
    title: 'Existing name',
    changed: false,
  });
  expect(methods['chat.regenerateTitle'].result.safeParse({ title: 'Name' }).success).toBe(false);
});
