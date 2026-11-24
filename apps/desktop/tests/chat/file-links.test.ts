import { describe, expect, it } from 'vitest';
import { fileLinkPath } from '../../src/lib/chat-links';
import { renderMarkdown } from '../../src/lib/markdown';

describe('file link targets', () => {
  it.each([
    ['docs/spec.md', 'docs/spec.md'],
    ['./docs/my%20spec.md#L12', './docs/my spec.md'],
    ['/tmp/spec.md:12:3', '/tmp/spec.md'],
    ['C:/Projects/spec.md', 'C:/Projects/spec.md'],
    ['file:///C:/Projects/my%20spec.md', 'C:/Projects/my spec.md'],
    ['file:///tmp/spec.md', '/tmp/spec.md'],
  ])('retains and decodes %s', (href, path) => {
    expect(fileLinkPath(href)).toBe(path);
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('[spec](' + href + ')');
    expect(root.querySelector('a')?.getAttribute('href')).toBe(href);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:a@b.c',
    '//server/share/spec.md',
    'file://server/share/spec.md',
    '#heading',
    '%00bad.md',
    'bad%zz.md',
  ])('rejects %s', (href) => {
    expect(fileLinkPath(href)).toBeNull();
  });
});
