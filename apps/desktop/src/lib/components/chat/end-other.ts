import type { ChatStatus } from '@threadgarden/protocol';

/**
 * Ending another Claude Code process that holds a chat (`external.stop`): End
 * the process in the chat header, beside its note, and in the blocked banner.
 * An idle holder is ended at once, since every message is already saved; one
 * mid-turn asks first, because ending it stops that turn.
 */
export const endOtherNeedsConfirm = (status: ChatStatus | undefined): boolean =>
  status === 'working' || status === 'needsYou';

export const END_OTHER_TITLE = 'End the other process?';
export const END_OTHER_DESCRIPTION =
  'Another Claude Code process is in the middle of a turn in this chat. Ending it stops that turn; the messages so far are saved.';
