import { describe, expect, it } from 'vitest';
import { editDiffs, summarize } from '../../src/lib/components/chat/tools';
import { tool } from './fixtures';

const edit = () =>
  tool('e1', 'Edit', { file_path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nc\n' });

describe('edit diffs', () => {
  it('computes an edit diff once per item and content', () => {
    const first = editDiffs(edit())!;
    // A new object for the same item (e.g. its status changed) reuses the computation.
    expect(editDiffs({ ...edit(), status: 'error' })).toBe(first);
    expect(summarize(edit()).stats).toEqual({ added: 1, removed: 1 });
    // Changed content is diffed again.
    const changed = tool('e1', 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'z' });
    expect(editDiffs(changed)).not.toBe(first);
  });

  it('summaries can skip diff stats (permission previews)', () => {
    expect(summarize(edit(), { stats: false })).toEqual({ verb: 'Edit', target: '/a.ts' });
  });
});
