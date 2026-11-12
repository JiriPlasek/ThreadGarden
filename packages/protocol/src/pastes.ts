/** CLI paste blocks use the same random id on both delimiters. */
export type PasteBlock = { start: number; end: number; id: string; text: string };

export const pasteBlocks = (text: string): PasteBlock[] => {
  const blocks: PasteBlock[] = [];
  const open = /<pasted_content id="([a-f\d]{4})">\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(text))) {
    const close = `</pasted_content id="${match[1]}">`;
    const end = text.indexOf(close, open.lastIndex);
    if (end < 0) continue;
    const raw = text.slice(open.lastIndex, end);
    const content = raw.replace(match[0].endsWith('\r\n') ? /\r?\n$/ : /\n$/, '');
    blocks.push({ start: match.index, end: end + close.length, id: match[1]!, text: content });
    open.lastIndex = end + close.length;
  }
  return blocks;
};

/**
 * `text` with each paste block replaced by `replace(block)`, together with the
 * blank lines the CLI puts around one (and the composer copies): `\n\n` before
 * and after it, or a single `\n` after it at the end of the message.
 */
export const replacePastes = (text: string, replace: (block: PasteBlock) => string): string => {
  let out = '';
  let start = 0;
  for (const block of pasteBlocks(text)) {
    const before = text.slice(start, block.start);
    out += (before.endsWith('\n\n') ? before.slice(0, -2) : before) + replace(block);
    start = text.startsWith('\n\n', block.end)
      ? block.end + 2
      : text.slice(block.end) === '\n'
        ? block.end + 1
        : block.end;
  }
  return out + text.slice(start);
};

/**
 * The prompt with each paste as the user put it, and the pastes: what goes to
 * the SDK (`inline_pastes`), so the CLI wraps them exactly as the terminal does.
 */
export const unwrapPastes = (text: string): { text: string; pastes: string[] } => {
  const pastes: string[] = [];
  const typed = replacePastes(text, (block) => {
    pastes.push(block.text);
    return block.text;
  });
  return { text: typed, pastes };
};

export const pasteLines = (text: string): number => text.split(/\r\n|\r|\n/).length;
export const pasteLabel = (number: number, text: string): string =>
  `[Pasted text #${number} +${pasteLines(text)} lines]`;

/** Readable text for titles, notifications and compact message previews. */
export const messagePreview = (text: string): string => {
  const blocks = pasteBlocks(text);
  let out = '';
  let start = 0;
  for (const [i, block] of blocks.entries()) {
    out += text.slice(start, block.start) + pasteLabel(i + 1, block.text);
    start = block.end;
  }
  return out + text.slice(start);
};
