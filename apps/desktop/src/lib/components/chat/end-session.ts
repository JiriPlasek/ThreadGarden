/**
 * The warning of ending a chat's Claude Code process, shared by End session
 * (chat header) and "End this chat and archive it?" (v1.2 §3): ending stops a
 * running turn and the chat's background tasks (agents, a dev server).
 */

/** How the End session confirmation ends its description. */
export const END_SESSION_AFTER = 'the chat stays in your history and can be resumed.';

/**
 * The description of the confirmation, or null when ending stops nothing
 * (no turn running, no background task). `listed`: the tasks are listed
 * below the description (known for a loaded chat; otherwise only counted).
 */
export const endSessionWarning = (o: {
  busy: boolean;
  tasks: number;
  listed: boolean;
  after?: string;
}): string | null => {
  const after = o.after ?? END_SESSION_AFTER;
  const n = o.tasks;
  if (!o.busy && n === 0) return null;
  const tasks = `${n} background ${n === 1 ? 'task' : 'tasks'}`;
  const these = o.listed ? `the ${tasks} below` : tasks;
  if (n === 0)
    return `Claude is still working in this chat. Ending stops the current turn; ${after}`;
  if (o.busy) {
    return `Claude is still working in this chat. Ending stops the current turn and ${these}; ${after}`;
  }
  return `This chat still runs ${these}. Ending the session stops them; ${after}`;
};
