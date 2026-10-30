import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX_LINES,
  MAX_DATA_IMAGE_CHARS,
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

  it('keeps http(s) links (opened by pahub, never by the webview) and drops other targets', () => {
    const html = renderMarkdown(
      '[site](https://example.com) [mail](mailto:a@b.example) [rel](/etc/passwd) [js](javascript:alert(1))',
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('target=');
    expect(html).not.toMatch(/mailto:|\/etc\/passwd|javascript:/);
    expect(html).toContain('mail');
  });

  it('neutralises html that could restyle, navigate or script the app', () => {
    const html = renderMarkdown(
      [
        '<style>body { display: none }</style>',
        '<form action="https://evil.example"><input name="q"><button>go</button></form>',
        '<iframe src="https://evil.example"></iframe>',
        '<object data="x"></object><embed src="x"><svg><script>alert(1)</script></svg>',
        '<div onclick="alert(1)" style="position:fixed" class="fixed inset-0" id="chat-panel">hi</div>',
        '<a href="javascript:alert(1)" onmouseover="alert(2)">j</a>',
        '<textarea>t</textarea><select><option>o</option></select><base href="https://evil.example/">',
      ].join('\n\n'),
    );
    for (const bad of [
      /<style/i,
      /<form/i,
      /<button/i,
      /<iframe/i,
      /<object/i,
      /<embed/i,
      /<svg/i,
      /<script/i,
      /<input/i,
      /<textarea/i,
      /<select/i,
      /<base/i,
      /\son\w+=/i,
      /style=/i,
      /class=/i,
      /id=/i,
      /javascript:/i,
    ]) {
      expect(html).not.toMatch(bad);
    }
    expect(html).toContain('hi');
  });

  it('keeps task-list checkboxes, disabled', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
  });

  it('renders remote images as links, never loading them (R22)', () => {
    const html = renderMarkdown(
      '![diagram](https://example.com/a.png) ![](https://example.com/b.png) <img src="https://example.com/c.png" alt="raw">',
    );
    expect(html).not.toMatch(/src="https?:/);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/a\.png"[^>]*>diagram<\/a>/);
    expect(html).toMatch(
      /<a href="https:\/\/example\.com\/b\.png"[^>]*>https:\/\/example\.com\/b\.png<\/a>/,
    );
  });

  it('keeps small data: images inline and drops oversized or non-raster ones', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(renderMarkdown(`![dot](${png})`)).toContain(`<img src="${png}" alt="dot"`);
    const huge = `data:image/png;base64,${'A'.repeat(MAX_DATA_IMAGE_CHARS)}`;
    expect(renderMarkdown(`![big](${huge})`)).not.toContain('<img');
    expect(renderMarkdown('![svg](data:image/svg+xml;base64,PHN2Zz4=)')).not.toContain('<img');
  });

  it('adds the code copy button after sanitising, and strips look-alikes from model output', () => {
    expect(renderMarkdown('```ts\nx\n```')).toMatch(/<button[^>]*data-copy-code/);
    expect(renderMarkdown('<button data-copy-code>x</button>')).not.toContain('<button');
    // A guessed placeholder cannot smuggle code-block html in.
    expect(renderMarkdown('<pre>PAHUB-CODE-0</pre>')).not.toContain('code-block');
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
