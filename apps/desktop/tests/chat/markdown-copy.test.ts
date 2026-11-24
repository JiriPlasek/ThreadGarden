import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/lib/markdown';
import { copyMarkdownSelection, selectionMarkdown } from '../../src/lib/markdown-copy';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
const select = (root: HTMLElement, range?: Range) => {
  document.body.append(root);
  const selected = range ?? document.createRange();
  if (!range) selected.selectNodeContents(root);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(selected);
  return selection;
};

describe('Markdown selection copy', () => {
  it('preserves lists, links, headings and code fences without copy controls', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(
      '# Title\n\n- **one**\n- [docs](https://example.com)\n\n~~~ts\nconst x = `a`;\n~~~',
    );
    const md = selectionMarkdown(root, select(root))!;
    expect(md).toContain('# Title');
    expect(md).toMatch(/-\s+\*\*one\*\*/);
    expect(md).toContain('[docs](https://example.com)');
    expect(md).toContain('```ts\nconst x = `a`;\n```');
    expect(md).not.toContain('Copy');
  });
  it('copies only selected text and retains its inline formatting', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('before **selected words** after');
    const text = root.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    expect(selectionMarkdown(root, select(root, range))).toBe('**selected**');
  });
  it('handles a selection crossing messages and writes synchronous plain Markdown', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div><p>first</p></div><div><ul><li>second</li></ul></div>';
    select(root);
    const setData = (type: string, value: string) => {
      expect(type).toBe('text/plain');
      expect(value).toMatch(/first\n\n-\s+second/);
    };
    let prevented = false;
    copyMarkdownSelection({
      currentTarget: root,
      clipboardData: { setData },
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ClipboardEvent);
    expect(prevented).toBe(true);
  });
  it('preserves GFM tables, task lists and code containing fences', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~~~md\n```ts\nx\n```\n~~~~',
    );
    const md = selectionMarkdown(root, select(root))!;
    expect(md).toMatch(/\| a\s*\| b\s*\|/);
    expect(md).toMatch(/\[x\]\s+done/);
    expect(md).toContain('````md\n```ts\nx\n```\n````');
  });
  it('leaves collapsed or out-of-scope selections alone', () => {
    const root = document.createElement('div');
    root.textContent = 'abc';
    const selection = select(root);
    selection.collapse(root.firstChild, 1);
    expect(selectionMarkdown(root, selection)).toBeNull();
    expect(selectionMarkdown(document.createElement('div'), select(root))).toBeNull();
  });
});
