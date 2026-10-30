/**
 * Files dropped from the OS (ruling R24). In the desktop app the webview
 * receives drops natively as paths (Tauri drag-drop events): images among
 * them are read by the shell's `read_dropped_image` command and attached,
 * every other file becomes an `@` mention. A drop is routed to the composer
 * under the cursor; drops anywhere else are ignored. Pasted text that is
 * one absolute path inside the chat's folder becomes a mention too.
 */
import { onFileDrop } from '#lib/native.js';
import { IMAGE_TYPES } from './input';

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The image media type a dropped path's extension stands for, if attachable. */
export const imageTypeOfPath = (path: string): string | null => {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const type = IMAGE_EXT[ext];
  return type && IMAGE_TYPES.includes(type) ? type : null;
};

const isWindowsPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');

/** Comparable form: forward slashes, no trailing slash, case-folded on Windows. */
const norm = (p: string): string => {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return isWindowsPath(p) ? s.toLowerCase() : s;
};

/** `path` relative to `cwd` (with `/`), or null when it is not inside it. */
export const relativeInside = (path: string, cwd: string): string | null => {
  if (!cwd) return null;
  const base = norm(cwd);
  const full = norm(path);
  if (!full.startsWith(`${base}/`)) return null;
  // Slice the original (case kept), not the case-folded copy.
  return path.replaceAll('\\', '/').slice(base.length + 1);
};

const quoted = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);

/**
 * The mention for a dropped path: relative to the chat folder when inside it,
 * else the absolute path; quoted when it has spaces; followed by a space.
 */
export const mentionForPath = (path: string, cwd: string): string =>
  `@${quoted(relativeInside(path, cwd) ?? path)} `;

const isAbsolute = (p: string): boolean => p.startsWith('/') || isWindowsPath(p);

/** For pasted text that is a single absolute path inside `cwd`: its mention; else null. */
export const pastedPathMention = (text: string, cwd: string): string | null => {
  const t = text.trim();
  if (!t || /[\r\n]/.test(t) || !isAbsolute(t)) return null;
  const rel = relativeInside(t, cwd);
  return rel ? `@${quoted(rel)} ` : null;
};

// ── routing ───────────────────────────────────────────────────────────────

export type DropTarget = {
  /** The composer's root element; a drop whose point is inside it goes there. */
  el: HTMLElement;
  drop: (paths: string[]) => Promise<void>;
  hover: (over: boolean) => void;
};

const targets = new Set<DropTarget>();
let listening: Promise<unknown> | null = null;

/** The element under a drop point (Tauri reports physical pixels). */
const targetAt = (point: { x: number; y: number }): DropTarget | undefined => {
  const at = document.elementFromPoint?.(point.x, point.y);
  if (!at) return undefined;
  for (const t of targets) if (t.el.contains(at)) return t;
  return undefined;
};

/** Delivers dropped paths to the composer under `point` (CSS pixels); ignored elsewhere. */
export const routeFileDrop = async (
  paths: string[],
  point: { x: number; y: number },
): Promise<void> => {
  for (const t of targets) t.hover(false);
  await targetAt(point)?.drop(paths);
};

const routeHover = (point: { x: number; y: number } | null): void => {
  const over = point ? targetAt(point) : undefined;
  for (const t of targets) t.hover(t === over);
};

/** Registers a composer as a drop target; returns the unregister function. */
export const registerDropTarget = (t: DropTarget): (() => void) => {
  targets.add(t);
  listening ??= onFileDrop({
    drop: (paths, point) => void routeFileDrop(paths, point),
    over: (point) => routeHover(point),
    leave: () => routeHover(null),
  }).catch(() => (listening = null));
  return () => {
    targets.delete(t);
  };
};
