import { pasteBlocks, pasteLabel, pasteLines, type ImageRef } from '@threadgarden/protocol';

export type Paste = { text: string; id: string };
const lineCounts = new WeakMap<Paste, number>();
/** Payloads stay out of the per-keystroke work after the first render. */
export const labelForPaste = (number: number, paste: Paste): string => {
  let lines = lineCounts.get(paste);
  if (lines === undefined) {
    lines = pasteLines(paste.text);
    lineCounts.set(paste, lines);
  }
  return `[Pasted text #${number} +${lines} lines]`;
};
/** Registries retain removed attachments until send, so native undo can recover them. */
export type AttachmentsState = {
  images: Record<number, ImageRef>;
  pastes: Record<number, Paste>;
  nextImage: number;
  nextPaste: number;
};
export type ComposerDraft = { text: string; attachments: AttachmentsState };
export type Tag = {
  start: number;
  end: number;
  label: string;
  number: number;
  kind: 'image' | 'paste';
};

export const tagsIn = (text: string): Tag[] =>
  [...text.matchAll(/\[Image #([1-9]\d*)\]|\[Pasted text #([1-9]\d*) \+(\d+) lines\]/g)].map(
    (m) => ({
      start: m.index!,
      end: m.index! + m[0].length,
      label: m[0],
      number: Number(m[1] ?? m[2]),
      kind: m[1] ? 'image' : 'paste',
    }),
  );

export const emptyAttachments = (): AttachmentsState => ({
  images: {},
  pastes: {},
  nextImage: 1,
  nextPaste: 1,
});
export const longPaste = (text: string): boolean => pasteLines(text) > 8 || text.length > 800;
export const imageLabel = (number: number): string => `[Image #${number}]`;
export const nextNumber = (text: string, state: AttachmentsState, kind: Tag['kind']): number =>
  Math.max(
    kind === 'image' ? state.nextImage : state.nextPaste,
    ...tagsIn(text)
      .filter((t) => t.kind === kind)
      .map((t) => t.number + 1),
  );

/** Avoid closing a block with delimiter-looking text inside the pasted payload. */
export const pasteId = (text: string): string => {
  const seed = crypto.getRandomValues(new Uint16Array(1))[0]!;
  for (let i = 0; i < 65536; i++) {
    const id = ((seed + i) % 65536).toString(16).padStart(4, '0');
    if (!text.includes(`</pasted_content id="${id}">`)) return id;
  }
  throw new Error('Pasted text contains every paste delimiter. Paste it as plain text instead.');
};

export const expandPastes = (text: string, state: AttachmentsState): string => {
  let out = '';
  let start = 0;
  for (const tag of tagsIn(text)) {
    const paste = tag.kind === 'paste' ? state.pastes[tag.number] : undefined;
    if (!paste || tag.label !== labelForPaste(tag.number, paste)) continue;
    out +=
      text.slice(start, tag.start) +
      `\n\n<pasted_content id="${paste.id}">\n${paste.text}\n</pasted_content id="${paste.id}">\n\n`;
    start = tag.end;
  }
  return out + text.slice(start);
};

export const imageNumbers = (text: string): number[] =>
  [
    ...new Set(
      tagsIn(text)
        .filter((t) => t.kind === 'image')
        .map((t) => t.number),
    ),
  ].sort((a, b) => a - b);

export const sentImageMap = (
  text: string,
  images: readonly ImageRef[],
): Record<number, ImageRef> => {
  const numbers = imageNumbers(text).slice(-images.length);
  return images.length === 0 ? {} : Object.fromEntries(numbers.map((n, i) => [n, images[i]!]));
};

export const activeImages = (text: string, state: AttachmentsState): [number, ImageRef][] =>
  imageNumbers(text).flatMap((n) =>
    state.images[n] ? [[n, state.images[n]!] as [number, ImageRef]] : [],
  );

export const outgoing = (
  text: string,
  state: AttachmentsState,
): { text: string; images: ImageRef[] } => ({
  text: expandPastes(text, state),
  images: activeImages(text, state).map(([, image]) => image),
});

/** Clipboard attachments receive fresh numbers in the destination draft. */
export const importMessage = (
  value: string,
  images: ImageRef[],
  text: string,
  current: AttachmentsState,
): ComposerDraft => {
  const imported = restoreMessage(value, images);
  const attachments = { ...current, images: { ...current.images }, pastes: { ...current.pastes } };
  const labels = new Map<string, string>();
  for (const tag of tagsIn(imported.text)) {
    if (labels.has(tag.label)) continue;
    const image = tag.kind === 'image' ? imported.attachments.images[tag.number] : undefined;
    const paste = tag.kind === 'paste' ? imported.attachments.pastes[tag.number] : undefined;
    if (!image && !paste) continue;
    const number = nextNumber(text + imported.text, attachments, tag.kind);
    if (image) {
      attachments.images[number] = image;
      attachments.nextImage = number + 1;
      labels.set(tag.label, imageLabel(number));
    }
    if (paste) {
      attachments.pastes[number] = paste;
      attachments.nextPaste = number + 1;
      labels.set(tag.label, labelForPaste(number, paste));
    }
  }
  let result = '';
  let start = 0;
  for (const tag of tagsIn(imported.text)) {
    result += imported.text.slice(start, tag.start) + (labels.get(tag.label) ?? tag.label);
    start = tag.end;
  }
  return { text: result + imported.text.slice(start), attachments };
};

/** Collapse saved/wire text, consuming only the padding added by serialization. */
export const restoreMessage = (value: string, images: ImageRef[] = []): ComposerDraft => {
  const state = emptyAttachments();
  let text = '';
  let start = 0;
  for (const block of pasteBlocks(value)) {
    const number = nextNumber(value + text, state, 'paste');
    const before = value.slice(start, block.start);
    text += before.endsWith('\n\n') ? before.slice(0, -2) : before;
    text += pasteLabel(number, block.text);
    state.pastes[number] = { text: block.text, id: block.id };
    state.nextPaste = number + 1;
    start = block.end + (value.slice(block.end, block.end + 2) === '\n\n' ? 2 : 0);
  }
  text += value.slice(start);
  state.images = sentImageMap(text, images);
  // Older scheduled messages had images without positional tags.
  const mapped = Object.keys(state.images).length;
  for (const image of images.slice(mapped)) {
    const number = nextNumber(text, state, 'image');
    state.images[number] = image;
    text += `${text && !/\s$/.test(text) ? ' ' : ''}${imageLabel(number)}`;
    state.nextImage = number + 1;
  }
  state.nextImage = nextNumber(text, state, 'image');
  return { text, attachments: state };
};
