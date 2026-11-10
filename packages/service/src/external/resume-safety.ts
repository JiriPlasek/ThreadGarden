/**
 * Resume safety (§4.4): resuming one session from two processes interleaves
 * both into one transcript, so Threadgarden refuses to resume a session that might be
 * running elsewhere. The policy is biased toward blocking when in doubt.
 */
import type { ChatStatus } from '@threadgarden/protocol';
import type { ExternalSession } from './poller.js';
import { isCodexSession } from '../sdk/providers.js';

export const RECENT_MODIFIED_MS = 120_000;

/** Status of an external session (§6.2 table); unrecognised values are `unknown`. */
export const externalStatus = (e: ExternalSession): ChatStatus => {
  const alive = e.pid !== undefined;
  if (e.status === 'waiting' || e.state === 'blocked') return 'needsYou';
  if (e.status === 'busy' || e.state === 'working') return 'working';
  if (e.status === 'idle') return 'idle';
  if (e.state === 'done' || e.state === 'stopped') return alive ? 'idle' : 'history';
  if (e.state === 'failed') return 'failed';
  return 'unknown';
};

/** Listed as ended: a known final state and no live process. */
const isEnded = (e: ExternalSession): boolean =>
  e.pid === undefined &&
  e.status === undefined &&
  (e.state === 'done' || e.state === 'failed' || e.state === 'stopped');

export type ResumeCheck = {
  status: 'ok' | 'blocked' | 'unverified';
  reason: string;
  recentlyModified: boolean;
  canStop?: boolean;
};

export const checkResume = (o: {
  sessionId: string;
  /** The external sessions, or null when `claude agents` is unavailable. */
  external: ExternalSession[] | null;
  /** The transcript's modification time as the SDK reports it (`SDKSessionInfo.lastModified`). */
  lastModified: number;
  now: number;
}): ResumeCheck => {
  const recentlyModified = o.now - o.lastModified < RECENT_MODIFIED_MS;
  const runtime = isCodexSession(o.sessionId) ? 'Codex' : 'Claude Code';
  if (o.external === null) {
    return {
      status: 'unverified',
      reason:
        runtime === 'Codex'
          ? 'Threadgarden cannot access the shared Codex runtime to check whether this chat is open elsewhere.'
          : "Threadgarden cannot check whether this chat is open in another Claude Code process (the 'claude agents' command is unavailable).",
      recentlyModified,
    };
  }
  const listed = o.external.filter((e) => e.sessionId === o.sessionId);
  const live = listed.find((e) => !isEnded(e));
  if (live) {
    const where =
      live.kind === 'background'
        ? 'as a background session'
        : live.pid !== undefined
          ? `in another ${runtime} process (pid ${live.pid})`
          : `in another ${runtime} process`;
    return {
      status: 'blocked',
      canStop:
        live.kind === 'background'
          ? !!live.shortId && /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(live.shortId)
          : live.pid !== undefined && Number.isSafeInteger(live.pid) && live.pid > 0,
      reason: `This chat is running ${where}. Resuming it here would mix both into one conversation.`,
      recentlyModified,
    };
  }
  if (runtime === 'Codex')
    return {
      status: 'unverified',
      reason:
        'This chat is not loaded in the shared Codex runtime. Independent Codex CLI processes cannot be ruled out; stop any other copy before continuing here.',
      recentlyModified,
    };
  return {
    status: 'ok',
    reason:
      listed.length > 0
        ? 'This chat is listed as finished.'
        : 'This chat is not running elsewhere.',
    recentlyModified,
  };
};

/** The terminal command that continues a session: `claude attach` for background sessions. */
export const resumeCommand = (sessionId: string, external: ExternalSession[] | null): string => {
  const bg = external?.find(
    (e) => e.sessionId === sessionId && e.kind === 'background' && e.shortId !== undefined,
  );
  return bg ? `claude attach ${bg.shortId}` : `claude --resume ${sessionId}`;
};
