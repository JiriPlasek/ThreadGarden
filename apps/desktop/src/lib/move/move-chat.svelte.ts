/**
 * Moving a chat to another machine (spec §3–§6): the desktop drives both
 * services. The source exports the chat in parts, the target imports and
 * commits it; once the target has committed, the move is done (ruling R2) and
 * the rest (the old copy hidden, scheduled sends, the draft, the tab, the
 * first note) follows.
 */
import { MOVE_ERRORS, type GitState, type MovePeer, type Result } from '@threadgarden/protocol';
import { supportsMove } from '../projects';
import { RequestError } from '../service/client';
import type { Api } from '../state/api';
import { machineNameOf, type MachinesState } from '../state/machines.svelte';
import type { PowerState } from '../state/power.svelte';
import type { ChatRef } from '../state/refs';
import type { Scopes } from '../state/scope';
import type { TabsState } from '../state/tabs.svelte';
import { moveNote } from './note';

/** How long a move waits for an Off target it turned on to come up (ruling R1). */
export const START_WAIT_MS = 10 * 60_000;
/** How often it looks whether the target is on meanwhile. */
const ON_POLL_MS = 1_000;
/**
 * The idempotent calls are tried this many times: `move.commit` after a lost
 * answer, `move.markMoved` before the old copy is said to be still shown (R2).
 */
const TRIES = 3;

export type MoveState =
  'idle' | 'checking' | 'ready' | 'starting' | 'moving' | 'noting' | 'done' | 'failed';

/** What the checks found: the chat's folder on the source, and where it goes on the target (null while the target is not on). */
export type MoveCheck = {
  source: Result<'move.check'>;
  target: Result<'move.target'> | null;
};

export type MoveApp = {
  scopes: Pick<Scopes, 'get'>;
  machines: Pick<MachinesState, 'get' | 'shown'>;
  power: Pick<PowerState, 'turnOn' | 'config' | 'error'>;
  tabs: Pick<TabsState, 'retarget'>;
};

export type MoveOptions = {
  /** The wait between `markMoved` tries (tests: 0). */
  retryMs?: number;
};

/** What stays on the source when a dirty project moves anyway, e.g. `3 changed files · 2 commits not pushed on fix/usage`. */
export const leftBehind = (git: GitState): string | null => {
  if (git.kind !== 'dirty') return null;
  const parts: string[] = [];
  if (git.changed > 0) parts.push(`${git.changed} changed ${git.changed === 1 ? 'file' : 'files'}`);
  if (git.unpushed > 0) {
    const commits = `${git.unpushed} ${git.unpushed === 1 ? 'commit' : 'commits'} not pushed`;
    parts.push(git.branch ? `${commits} on ${git.branch}` : commits);
  }
  return parts.join(' · ') || null;
};

/** The repository's name: the origin URL's last part, else the folder's. */
const repoNameOf = (origin: string | null, cwd: string): string => {
  const last = (s: string): string =>
    s
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .at(-1) ?? s;
  return origin ? last(origin).replace(/\.git$/, '') : last(cwd);
};

const reason = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong.';

/** The answer was lost on the way (the call may have done its work). */
const lost = (e: unknown): boolean =>
  e instanceof RequestError && (e.code === 'TIMEOUT' || e.code === 'DISCONNECTED');

const expired = (e: unknown): boolean =>
  e instanceof RequestError && e.code === MOVE_ERRORS.expired;

const pause = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** `markMoved` answered EXPIRED: the chat went on on the source after its lock ran out. */
const tooLong = (source: string, target: string): string =>
  `The move took too long and ${source} went on with this chat, so it stays there. The copy on ${target} is left as it was.`;

/** A failure that ends the move before anything was asked of a service. */
class Refused extends Error {}

export class MoveChat {
  state = $state<MoveState>('idle');
  check = $state<MoveCheck | null>(null);
  problem = $state<string | null>(null);
  /** The target has the chat but the source still lists its old copy (`markMoved` failed, R2). */
  oldCopyShown = $state(false);

  private ref: ChatRef | null = null;
  private targetId: string | null = null;
  /** The folder the owner picked (Browse…); else the target's choice. */
  private folder: string | null = null;
  private exportId: string | null = null;
  private note: string | null = null;
  private readonly retryMs: number;

  constructor(
    private readonly app: MoveApp,
    o: MoveOptions = {},
  ) {
    this.retryMs = o.retryMs ?? 1_000;
  }

  /** Runs the checks: `move.check` on the source, and `move.target` when the target is on. */
  prepare = async (ref: ChatRef, target: string, folder?: string): Promise<void> => {
    this.ref = ref;
    this.targetId = target;
    this.folder = folder ?? null;
    this.check = null;
    this.problem = null;
    this.oldCopyShown = false;
    this.state = 'checking';
    try {
      const source = await this.api(ref.machineId).request('move.check', {
        sessionId: ref.sessionId,
      });
      const there = this.isOn(target) ? await this.whereOnTarget(source) : null;
      this.check = { source, target: there };
      this.state = 'ready';
    } catch (e) {
      this.fail(reason(e));
    }
  };

  /** Moves the prepared chat; a dirty project (or no git repo) moves only with `moveAnyway`. */
  run = async (opts: { moveAnyway: boolean }): Promise<void> => {
    const { ref, targetId, check } = this;
    if (!ref || !targetId || !check || (this.state !== 'ready' && this.state !== 'failed')) return;
    this.problem = null;
    this.oldCopyShown = false;
    const sourceName = this.nameOf(ref.machineId);
    const targetName = this.nameOf(targetId);
    const git = check.source.git;
    const source = this.app.scopes.get(ref.machineId)?.api;
    if (!source) return this.fail(`${sourceName} is not paired`);
    const exportId = crypto.randomUUID();
    this.exportId = exportId;

    let there = check.target;
    let folder: string;
    try {
      this.refuseUnlessMovable(git, opts.moveAnyway, sourceName, targetId, targetName);
      // 1. An Off target with power control is turned on first (R1).
      await this.bringUp(targetId, targetName);
      if (!supportsMove(this.app.machines.get(targetId))) {
        throw new Error(`Update ${targetName} to move chats there`);
      }
      this.state = 'moving';
      const target = this.api(targetId);
      // 2. Where the chat goes, if the target was not on for the checks.
      there ??= await this.whereOnTarget(check.source);
      this.check = { source: check.source, target: there };
      folder = this.folder ?? there.folder;
      // 3–5. The export, part by part into the import, then the commit.
      const begun = await source.request('move.exportBegin', {
        sessionId: ref.sessionId,
        exportId,
      });
      const importId = crypto.randomUUID();
      for (let index = 0; index < begun.parts; index++) {
        const { keys } = await source.request('move.exportPart', { exportId, index });
        await target.request('move.importPart', {
          importId,
          sessionId: ref.sessionId,
          index,
          parts: begun.parts,
          keys,
        });
      }
      const commit = {
        importId,
        sessionId: ref.sessionId,
        cwd: folder,
        from: this.peer(ref.machineId),
      };
      await this.tried(() => target.request('move.commit', commit), lost);
    } catch (e) {
      if (!(e instanceof Refused)) {
        // Nothing moved: the source unlocks the chat (a lost exportBegin answer included).
        await source.request('move.abort', { exportId }).catch(() => {});
      }
      this.fail(reason(e));
      return;
    }

    // 7. The old copy on the source is hidden. Before the scheduled sends: a
    // chat that went on there (EXPIRED) stays, its sends with it.
    const marked = await this.markMoved();
    if (marked === 'expired') return this.fail(tooLong(sourceName, targetName));
    this.oldCopyShown = marked === 'failed';

    const to: ChatRef = { machineId: targetId, sessionId: ref.sessionId };
    // 6. Scheduled sends follow the chat (R7); 8. so does the draft.
    await this.moveScheduled(ref, targetId);
    await this.copyDraft(ref, targetId);
    // 9. The tab follows it.
    this.app.tabs.retarget(ref, to);
    // 10. Claude's first note (R4).
    this.note = moveNote({
      from: sourceName,
      to: targetName,
      folder,
      origin: git.kind === 'notRepo' ? null : git.origin,
      branch: git.kind === 'notRepo' ? null : git.branch,
      leftBehind: leftBehind(git),
      inUse: !!there?.inUse && folder === there.folder,
    });
    await this.sendNoteAgain();
  };

  /** Tries `markMoved` again after it failed (the old copy was still shown). */
  retryMarkMoved = async (): Promise<void> => {
    if (!this.oldCopyShown) return;
    const marked = await this.markMoved();
    if (marked === 'done') this.oldCopyShown = false;
    else if (marked === 'expired' && this.ref && this.targetId) {
      this.oldCopyShown = false;
      this.problem = tooLong(this.nameOf(this.ref.machineId), this.nameOf(this.targetId));
    }
  };

  /** Sends the first note on the target (again, after it failed). */
  sendNoteAgain = async (): Promise<void> => {
    const { ref, targetId, note } = this;
    if (!ref || !targetId || note === null) return;
    try {
      await this.api(targetId).request('chat.send', { sessionId: ref.sessionId, text: note });
      this.problem = null;
      this.state = 'done';
    } catch (e) {
      this.problem = reason(e);
      this.state = 'noting';
    }
  };

  /** Asks Claude, in the chat on its machine, to commit and push first (§3); moves nothing. */
  askToPush = async (ref: ChatRef): Promise<void> => {
    const api = this.api(ref.machineId);
    try {
      const git =
        this.check && this.ref?.sessionId === ref.sessionId
          ? this.check.source.git
          : (await api.request('move.check', { sessionId: ref.sessionId })).git;
      const branch = git.kind === 'notRepo' ? null : git.branch;
      const target = this.targetId ? this.nameOf(this.targetId) : 'another machine';
      await api.request('chat.send', {
        sessionId: ref.sessionId,
        text: `Please commit your work and push it to its branch (${branch ?? 'detached HEAD'}), so this chat can move to ${target}. If it isn't ready for that branch, push it to a new WIP branch instead and tell me its name.`,
      });
      this.state = 'idle';
    } catch (e) {
      this.fail(reason(e));
    }
  };

  private api = (machineId: string): Api => {
    const scope = this.app.scopes.get(machineId);
    if (!scope) throw new Error(`${this.nameOf(machineId)} is not paired`);
    return scope.api;
  };

  private nameOf = (machineId: string): string => machineNameOf(this.app.machines, machineId);

  private peer = (machineId: string): MovePeer => ({ machineId, name: this.nameOf(machineId) });

  private isOn = (machineId: string): boolean => this.app.machines.get(machineId)?.status === 'on';

  private whereOnTarget = (source: Result<'move.check'>): Promise<Result<'move.target'>> => {
    const { git, cwd } = source;
    const origin = git.kind === 'notRepo' ? null : git.origin;
    return this.api(this.targetId!).request('move.target', {
      origin,
      repoName: repoNameOf(origin, cwd),
      branch: git.kind === 'notRepo' ? null : git.branch,
    });
  };

  private fail = (problem: string): void => {
    this.problem = problem;
    this.state = 'failed';
  };

  /** What stops a move before any service is asked: unpushed work without Move anyway, a target that can't be started. */
  private refuseUnlessMovable = (
    git: GitState,
    moveAnyway: boolean,
    sourceName: string,
    targetId: string,
    targetName: string,
  ): void => {
    if (!moveAnyway) {
      if (git.kind === 'notRepo') {
        throw new Refused(`This folder isn't a git repo; its files stay on ${sourceName}`);
      }
      const left = leftBehind(git);
      if (left) throw new Refused(left);
    }
    if (!this.isOn(targetId) && !this.app.power.config(targetId)) {
      throw new Refused(`${targetName} is off`);
    }
  };

  /** Turns an Off target on (R1) and waits until its link is on; throws when it does not come up. */
  private bringUp = async (id: string, name: string): Promise<void> => {
    if (this.isOn(id)) return;
    const m = this.app.machines.get(id);
    const shown = m ? this.app.machines.shown(m) : 'unreachable';
    if (shown !== 'off' && shown !== 'starting') throw new Error(`${name} can't be reached`);
    this.state = 'starting';
    if (shown === 'off' && !(await this.app.power.turnOn(id))) {
      throw new Error(this.app.power.error(id) ?? `${name} couldn't be turned on`);
    }
    const deadline = Date.now() + START_WAIT_MS;
    while (!this.isOn(id)) {
      if (Date.now() >= deadline) throw new Error(`${name} didn't come up in 10 minutes`);
      await pause(ON_POLL_MS);
    }
  };

  /** `call`, tried up to `TRIES` times while it fails with an error `again` accepts. */
  private tried = async <T>(call: () => Promise<T>, again: (e: unknown) => boolean): Promise<T> => {
    for (let i = 1; ; i++) {
      try {
        return await call();
      } catch (e) {
        if (i >= TRIES || !again(e)) throw e;
        await pause(this.retryMs);
      }
    }
  };

  /** `markMoved`, tried `TRIES` times; `expired` when the chat went on on the source. */
  private markMoved = async (): Promise<'done' | 'expired' | 'failed'> => {
    const { ref, targetId, exportId } = this;
    if (!ref || !targetId || !exportId) return 'failed';
    const params = { exportId, to: this.peer(targetId) };
    try {
      await this.tried(
        () => this.api(ref.machineId).request('move.markMoved', params),
        (e) => !expired(e),
      );
      return 'done';
    } catch (e) {
      return expired(e) ? 'expired' : 'failed';
    }
  };

  /**
   * The chat's pending scheduled sends, re-created on the target with the same
   * id (R7): one waiting for the limit reset follows the target's own reset, a
   * timed one keeps its time. One the target did not take stays on the source.
   */
  private moveScheduled = async (ref: ChatRef, targetId: string): Promise<void> => {
    const source = this.api(ref.machineId);
    const target = this.api(targetId);
    let items: Result<'scheduled.list'>['items'];
    try {
      ({ items } = await source.request('scheduled.list', { sessionId: ref.sessionId }));
    } catch {
      return;
    }
    for (const s of items) {
      if (s.state !== 'pending') continue;
      try {
        const images =
          s.imageCount > 0
            ? (await source.request('scheduled.get', { id: s.id })).images
            : undefined;
        await target.request('scheduled.create', {
          sessionId: ref.sessionId,
          id: s.id,
          text: s.text,
          ...(images ? { images } : {}),
          ...(s.afterLimitReset ? { whenLimitResets: true as const } : { sendAt: s.sendAt }),
        });
        await source.request('scheduled.cancel', { id: s.id });
      } catch {
        // Not taken by the target (or not cancelled): it stays where it is.
      }
    }
  };

  /** The composer's unsent text follows the chat. */
  private copyDraft = async (ref: ChatRef, targetId: string): Promise<void> => {
    try {
      const { text } = await this.api(ref.machineId).request('drafts.get', {
        key: ref.sessionId,
      });
      if (text) {
        await this.api(targetId).request('drafts.set', { key: ref.sessionId, text });
      }
    } catch {
      // A draft is a convenience; the move is done without it.
    }
  };
}
