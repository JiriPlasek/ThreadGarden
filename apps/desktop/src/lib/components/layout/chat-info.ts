import type { ChatSummary } from '@pahub/protocol';

/** The source's own status text for an external session (shown when pahub does not know it). */
export const rawStatus = (
  s: Pick<ChatSummary, 'external'> | null | undefined,
): string | undefined => s?.external?.state ?? s?.external?.status ?? undefined;

/** One line under the title: what the chat waits for, else its preview (spec §6.1). */
export const previewLine = (s: Pick<ChatSummary, 'status' | 'waitingFor' | 'preview'>): string =>
  (s.status === 'needsYou' && s.waitingFor) || s.preview || '';

/** Last path segment, for chats whose project is not in the project list. */
export const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Describes an external session for its glyph's tooltip. */
export const externalLabel = (s: Pick<ChatSummary, 'external'>): string =>
  s.external ? `Running outside pahub (${s.external.kind})` : '';

/** DOM id of a chat's tab (the chat panel is labelled by it). */
export const tabId = (sessionId: string): string => `tab-${sessionId}`;
