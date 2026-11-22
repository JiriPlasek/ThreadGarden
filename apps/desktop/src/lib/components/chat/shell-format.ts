import type { ShellRun } from '@threadgarden/protocol';
import { elapsed } from './format';

/** Rows a command's terminal shows before it scrolls. */
export const SHELL_BLOCK_ROWS = 24;
/** Lines of history the terminal keeps. */
export const SHELL_SCROLLBACK_LINES = 5000;

const SEES = 'Claude sees the output with your next message';

/** The line under a command's terminal (`now` is the clock for a running command). */
export const shellFooter = (run: ShellRun, now: number): string => {
  if (run.state !== 'ended') return `Running · ${elapsed(now - run.startedAt)}`;
  if (run.endReason === 'session') return 'Stopped when the session ended · not added to the chat';
  const took = elapsed((run.endedAt ?? now) - run.startedAt);
  if (run.endReason === 'stopped') return `Stopped · ${took} · ${SEES}`;
  const mark = run.exitCode === 0 ? '✓' : '✗';
  return `${mark} exit ${run.exitCode ?? '?'} · ${took} · ${SEES}`;
};

/** `cwd` with the home folder shown as `~`. */
const folderOf = (cwd: string, home: string): string => {
  const base = home.replace(/[/\\]+$/, '');
  if (!base) return cwd;
  if (cwd === base) return '~';
  const next = cwd.charAt(base.length);
  const under = cwd.startsWith(base) && (next === '/' || next === '\\');
  return under ? `~${cwd.slice(base.length)}` : cwd;
};

/** `! ‹command› · ‹machine› · ‹folder, ~ for home›`. */
export const shellTitle = (run: ShellRun, machineName: string, home: string): string =>
  `! ${run.command} · ${machineName} · ${folderOf(run.cwd, home)}`;
