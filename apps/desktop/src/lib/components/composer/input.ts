/**
 * Pure text helpers behind the composer: which picker the caret is in (`@`
 * mention or `/` command), what to insert for a choice, and image checks.
 * Cheap enough to run on every keystroke (no layout, no allocation beyond
 * the small result).
 */
import type { ImageRef } from '@pahub/protocol';

export type Token = { start: number; end: number; query: string };

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * The `@query` the caret is in: an `@` at the start or after whitespace,
 * followed by non-whitespace up to the caret. `end` extends over the rest of
 * the word so a choice replaces all of it.
 */
export const mentionAt = (text: string, caret: number): Token | null => {
  let i = caret;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  if (text[i] !== '@') return null;
  const query = text.slice(i + 1, caret);
  if (query.includes('@') || query.startsWith('"')) return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end++;
  return { start: i, end, query };
};

/**
 * The `/command` being typed: only at the very start of the message (as in
 * the CLI) and while the caret is still in the command word.
 */
export const slashAt = (text: string, caret: number): Token | null => {
  if (!text.startsWith('/')) return null;
  const head = text.slice(0, caret);
  if (/\s/.test(head)) return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end++;
  return { start: 0, end, query: head.slice(1) };
};

/** `text` with `[start, end)` replaced by `insert`, and the caret after it. */
export const replaceRange = (
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } => ({
  text: text.slice(0, start) + insert + text.slice(end),
  caret: start + insert.length,
});

/**
 * What a picked file or folder becomes in the message: `@path ` like the CLI
 * (quoted when the path has spaces). Folders end in `/` without a trailing
 * space so the picker continues inside them.
 */
export const mentionText = (path: string, kind: 'file' | 'dir'): string => {
  const p = kind === 'dir' && !path.endsWith('/') ? `${path}/` : path;
  const quoted = /\s/.test(p) ? `"${p}"` : p;
  return kind === 'dir' && quoted === p ? `@${p}` : `@${quoted} `;
};

/** Splits a relative path into its folder part and its name (for the picker rows). */
export const splitPath = (path: string): { dir: string; name: string } => {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at < 0
    ? { dir: '', name: trimmed }
    : { dir: trimmed.slice(0, at + 1), name: trimmed.slice(at + 1) };
};

type Named = { name: string; description: string };

/** Commands matching `query`: name prefix first, then name or description containing it. */
export const filterCommands = <T extends Named>(commands: readonly T[], query: string): T[] => {
  const q = query.toLowerCase();
  if (!q) return commands.slice();
  const prefix: T[] = [];
  const rest: T[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q) || c.description.toLowerCase().includes(q)) rest.push(c);
  }
  return [...prefix, ...rest];
};

// ── images ────────────────────────────────────────────────────────────────

export const IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * All images of one message together. As base64 (~27 MiB) they still fit the
 * service's request limit (`MAX_REQUEST_BYTES`), so a send never fails on size.
 */
export const MAX_MESSAGE_IMAGE_BYTES = 4 * MAX_IMAGE_BYTES;

/** Decoded size of a base64 image (`=` padding excluded). */
const imageBytes = (img: ImageRef): number => {
  const pad = img.data.endsWith('==') ? 2 : img.data.endsWith('=') ? 1 : 0;
  return Math.floor((img.data.length * 3) / 4) - pad;
};

/**
 * The incoming images that still fit the message's image budget next to the
 * ones already attached, and why the rest were not attached (null when all fit).
 */
export const fitImages = (
  attached: readonly ImageRef[],
  incoming: readonly ImageRef[],
): { accepted: ImageRef[]; problem: string | null } => {
  let total = attached.reduce((n, img) => n + imageBytes(img), 0);
  const accepted: ImageRef[] = [];
  for (const img of incoming) {
    const size = imageBytes(img);
    if (total + size > MAX_MESSAGE_IMAGE_BYTES) continue;
    total += size;
    accepted.push(img);
  }
  const refused = incoming.length - accepted.length;
  return {
    accepted,
    problem:
      refused === 0
        ? null
        : `${refused} image${refused === 1 ? ' was' : 's were'} not attached: the images of one message can total at most ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MB`,
  };
};

/** Why an image cannot be attached, or null when it can. */
export const imageProblem = (file: { name: string; type: string; size: number }): string | null => {
  const name = file.name || 'Pasted image';
  if (!IMAGE_TYPES.includes(file.type)) {
    return `${name}: only PNG, JPEG, GIF and WebP images can be attached`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `${name} is ${mb} MB; images can be at most 5 MB`;
  }
  return null;
};

/** Reads an image file as base64 image content. */
export const readImage = (file: Blob): Promise<ImageRef> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve({ mediaType: file.type, data: comma < 0 ? '' : url.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });

/** Image files among pasted or dropped data (files first, then clipboard items). */
export const imageFiles = (data: DataTransfer | null): File[] => {
  if (!data) return [];
  const files = [...(data.files ?? [])];
  if (files.length > 0) return files.filter((f) => f.type.startsWith('image/'));
  const out: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
};
