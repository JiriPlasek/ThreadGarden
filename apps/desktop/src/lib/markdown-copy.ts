import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const converter = new TurndownService({
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  headingStyle: 'atx',
});
converter.use(gfm);
converter.remove(['button']);
converter.addRule('chatCode', {
  filter: 'pre',
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const code = element.textContent ?? '';
    const lang = element.closest('.code-block')?.getAttribute('data-lang') ?? '';
    const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return '\n\n' + fence + lang + '\n' + code.replace(/\n$/, '') + '\n' + fence + '\n\n';
  },
});

/** Clone only the selected content, retaining the ancestors that give it meaning. */
export const selectionMarkdown = (root: HTMLElement, selection: Selection): string | null => {
  if (selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  let fragment: Node = range.cloneContents();
  let ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode!;
  while (ancestor !== root && root.contains(ancestor)) {
    const wrapper = ancestor.cloneNode(false);
    wrapper.appendChild(fragment);
    fragment = wrapper;
    ancestor = ancestor.parentNode!;
  }
  const box = document.createElement('div');
  box.appendChild(fragment);
  box.querySelectorAll('.code-head, button').forEach((node) => node.remove());
  return converter.turndown(box);
};

/** Use the synchronous copy event so both Ctrl+C and the context menu work. */
export const copyMarkdownSelection = (event: ClipboardEvent): void => {
  if (event.defaultPrevented || !event.clipboardData) return;
  const selection = window.getSelection();
  if (!selection) return;
  const markdown = selectionMarkdown(event.currentTarget as HTMLElement, selection);
  if (markdown === null) return;
  event.clipboardData.setData('text/plain', markdown);
  event.preventDefault();
};
