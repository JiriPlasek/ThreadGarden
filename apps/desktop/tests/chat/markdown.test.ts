import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX_LINES,
  highlightMarkdown,
  renderCached,
  renderMarkdown,
} from '../../src/lib/markdown';

describe('markdown', () => {
  it('markdown strips script tags', () => {
    const html = renderMarkdown(
      'hello <script>alert(1)</script> <img src="x" onerror="alert(2)"> [x](javascript:alert(3))',
    );
    expect(html).toContain('hello');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('renders gfm tables, lists and inline code', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- `two`');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>two</code>');
  });

  it('external links open in a new context without opener', () => {
    const html = renderMarkdown('[site](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('code blocks render as plain text first, with a language label and copy button', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('const a = 1 &lt; 2;');
    expect(html).toContain('data-copy-code');
  });

  it('highlights code lazily with shiki and keeps unknown languages plain', async () => {
    const html = await highlightMarkdown('```ts\nconst a = 1;\n```\n\n```nosuchlang\nplain\n```');
    expect(html).toContain('class="shiki');
    expect(html).toContain('--shiki-dark');
    expect(html).toContain('plain');
    expect(html).not.toMatch(/<script/i);
  }, 20_000);

  it('skips highlighting huge blocks', async () => {
    const big = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => `x${i}`).join('\n');
    const html = await highlightMarkdown('```js\n' + big + '\n```');
    expect(html).not.toContain('class="shiki');
    expect(html).toContain(`x${HIGHLIGHT_MAX_LINES}`);
  });

  it('caches rendered html per item id and content', () => {
    const a = renderCached('item-1', 'same **text**');
    const b = renderCached('item-1', 'same **text**');
    expect(b).toBe(a);
    expect(renderCached('item-1', 'other')).toContain('other');
  });
});
