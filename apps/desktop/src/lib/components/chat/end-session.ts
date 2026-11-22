/**
 * The warning of ending a chat's Claude Code process, shared by End session
 * (chat header) and "End this chat and archive it?" (v1.2 §3): ending stops a
 * running turn, the chat's background tasks (agents, a dev server) and its
 * running `!` command.
 */

/** How the End session confirmation ends its description. */
export const END_SESSION_AFTER = 'the chat stays in your history and can be resumed.';

type Running = { busy: boolean; agentName?: string; tasks: number; listed: boolean };

/** What the turn and the background tasks add to the warning, or null when neither runs. */
const turnAndTasks = (o: Running, after: string): string | null => {
  const n = o.tasks;
  if (!o.busy && n === 0) return null;
  const tasks = `${n} background ${n === 1 ? 'task' : 'tasks'}`;
  const these = o.listed ? `the ${tasks} below` : tasks;
  if (n === 0)
    return `${o.agentName ?? 'Claude'} is still working in this chat. Ending stops the current turn; ${after}`;
  if (o.busy) {
    return `${o.agentName ?? 'Claude'} is still working in this chat. Ending stops the current turn and ${these}; ${after}`;
  }
  return `This chat still runs ${these}. Ending the session stops them; ${after}`;
};

/**
 * The description of the confirmation, or null when ending stops nothing
 * (no turn running, no background task, no `!` command). `listed`: the tasks
 * are listed below the description (known for a loaded chat; otherwise only
 * counted). `command`: a `!` command still running, named first.
 */
export const endSessionWarning = (
  o: Running & { after?: string; command?: string },
): string | null => {
  const after = o.after ?? END_SESSION_AFTER;
  const rest = turnAndTasks(o, after);
  if (o.command === undefined) return rest;
  // `after` alone starts a sentence here.
  const tail = rest ?? after.charAt(0).toUpperCase() + after.slice(1);
  return `\`! ${o.command}\` is still running; ending the session stops it. ${tail}`;
};
