/**
 * Sending New chat's first message, for every tab: what a send carries, and
 * the step New project and Clone share once their folder exists (start the
 * chat in it). The folder stays whatever follows; when the chat doesn't
 * start, the dialog offers Start there with what `startInMade` returns.
 */
import type { ImageRef } from '@threadgarden/protocol';
import { RequestError } from '#lib/service/client.js';
import { newChatDraftKey, type InteractionState } from '#lib/state/interaction.svelte.js';
import type { MachineScope } from '#lib/state/scope.js';
import { outgoing } from '#lib/components/composer/tags.js';

/** Everything a send needs, taken when it is sent: a machine switch meanwhile changes none of it. */
export type Send = {
  target: MachineScope;
  /** The composer's draft when it was sent. */
  draftKey: string;
  text: string;
  chat: { text: string; images: ImageRef[]; model?: string; permissionMode?: string };
};

export const sendOf = (o: {
  target: MachineScope;
  draftKey: string;
  text: string;
  images: ImageRef[];
  model: string;
  mode: string;
}): Send => ({
  target: o.target,
  draftKey: o.draftKey,
  text: o.text,
  chat: {
    text: o.text,
    images: o.images,
    ...(o.model ? { model: o.model } : {}),
    ...(o.mode !== 'default' ? { permissionMode: o.mode } : {}),
  },
});

/** `send` with the message as it is now in its draft (else as it was sent). */
export const asNow = (send: Send): Send => {
  const interaction = send.target.interaction;
  const draft = interaction.cachedAttachments(send.draftKey);
  const current = draft ? outgoing(draft.text, draft.attachments) : null;
  const saved = interaction.cachedDraft(send.draftKey);
  const text = current?.text ?? saved?.text ?? send.text;
  const images = current?.images ?? saved?.images ?? send.chat.images;
  return { ...send, text, chat: { ...send.chat, text, images } };
};

/** A folder the service just made for a new chat (`problem`: a step it skipped, e.g. the repo). */
export type MadeFolder = {
  /** What the owner calls it: the project's or the repo's name. */
  name: string;
  path: string;
  problem: string | null;
};

/** A made folder whose chat did not start, why, and the message meant for it. */
export type NotStarted = {
  machineId: string;
  name: string;
  path: string;
  reason: string;
  draftKey: string;
  text: string;
};

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Claude Code gone missing: the status refresh brings up the setup screen. */
export const noteMissingClaude = (target: MachineScope, err: unknown): void => {
  if (err instanceof RequestError && err.code === 'CLAUDE_MISSING') {
    target.interaction.loadStatus().catch(() => {});
  }
};

/** What the dialog's alert says about a folder made without its chat. */
export const notStartedText = (n: NotStarted): string =>
  `${n.name} was created, but the chat didn't start: ${n.reason}`;

/**
 * Starts the chat in `made.path` with `start`, unless the service reported a
 * problem. Resolves null once it started, else what was made and why not.
 */
export const startInMade = async (
  send: Send,
  made: MadeFolder,
  start: (cwd: string) => Promise<void>,
): Promise<NotStarted | null> => {
  const left = (reason: string): NotStarted => ({
    machineId: send.target.machineId,
    name: made.name,
    path: made.path,
    reason,
    draftKey: send.draftKey,
    text: send.text,
  });
  if (made.problem) return left(made.problem);
  try {
    await start(made.path);
    return null;
  } catch (err) {
    return left(errorText(err));
  }
};

/** Start there: the message as it is now (else as it was sent) becomes the made folder's draft. */
export const moveDraft = (
  interaction: Pick<
    InteractionState,
    'cachedDraft' | 'saveDraft' | 'clearDraft' | 'moveAttachments'
  >,
  n: NotStarted,
): void => {
  interaction.saveDraft(
    newChatDraftKey(n.path),
    interaction.cachedDraft(n.draftKey) ?? { text: n.text, images: [] },
  );
  interaction.moveAttachments(n.draftKey, newChatDraftKey(n.path));
  interaction.clearDraft(n.draftKey);
};
