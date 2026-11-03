/** The message Threadgarden sends into a moved chat on its new machine (spec §4, ruling R4). */

const PREFIX = '[Threadgarden] ';

export interface MoveNoteInput {
  from: string;
  to: string;
  /** The folder the chat now works in, on the target. */
  folder: string;
  /** The project's `origin` URL; null when the source folder is not a git repo. */
  origin: string | null;
  /** The branch the chat was on at the time of the move. */
  branch: string | null;
  /** What stayed on the source after "Move anyway", e.g. "3 changed files"; null when nothing. */
  leftBehind: string | null;
  /** The target folder is on another branch while other chats run there. */
  inUse: boolean;
}

export function moveNote(o: MoveNoteInput): string {
  const lines: string[] = [
    `${PREFIX}This chat moved from ${o.from} to ${o.to}.`,
    '',
    `The chat now works in this folder on ${o.to}: ${o.folder}`,
  ];

  if (o.origin === null) {
    lines.push(
      '',
      `The project's files are not here: this folder is not a git repo; its files stayed on ${o.from}. Do not assume they exist on ${o.to}.`,
    );
  } else {
    const branch = o.branch ? `the branch \`${o.branch}\`` : 'the same branch it was on';
    lines.push(
      '',
      `The repo is ${o.origin}, and the chat was on ${branch}.`,
      '',
      'Get the repo ready now:',
      '1. If the folder is missing, clone the repo into it.',
      `2. Fetch, then check out ${o.branch ? `\`${o.branch}\`` : 'that branch'}.`,
      '',
      'Never stash, reset, overwrite or switch a working copy that has uncommitted changes, or one that other chats use. If that is the case here, stop and ask the owner what to do.',
    );
    if (o.inUse) {
      lines.push(
        '',
        `This folder is currently on another branch, and other chats are running in it. Do not switch branches. Stop and ask the owner first. Never create a worktree on your own: this chat's folder is fixed, so a worktree would leave the chat pointing at the wrong place.`,
      );
    }
  }

  if (o.leftBehind) {
    lines.push(
      '',
      `Not everything came along. What stayed on ${o.from} and is not here: ${o.leftBehind}. Do not assume it exists on ${o.to}.`,
    );
  }

  return lines.join('\n');
}

export function isThreadgardenNote(text: string): boolean {
  return text.startsWith(PREFIX);
}
