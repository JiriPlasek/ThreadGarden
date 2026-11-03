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
/** How long a call whose answer was lost waits for its machine to be on again before it is tried again. */
export const RECONNECT_WAIT_MS = 2 * 60_000;
/** How often it looks whether a machine is on meanwhile. */
const ON_POLL_MS = 1_000;
/**
 * Calls are tried this many times: the idempotent transfer calls after a lost
 * answer, `move.markMoved` before the old copy is said to be still shown (R2),
 * a scheduled send's cancel on the source.
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
  /** The wait between tries of a failed call (tests: 0). */
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

const isExpired = (e: unknown): boolean =>
  e instanceof RequestError && e.code === MOVE_ERRORS.expired;

const pause = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** `markMoved` answered EXPIRED: the chat went on on the source after its lock ran out. */
const tooLong = (source: string, target: string): string =>
  `The move took too long and ${source} went on with this chat, so it stays there. The copy on ${target} is left as it was.`;

/** The commit's answer never came, and the target did not come back to say. */
const mayHaveReached = (target: string): string =>
  `The move may have reached ${target}; check there before moving again.`;

/** The move was abandoned (`abandon()`): whatever it awaited is dropped. */
class Cancelled extends Error {}

/** One move, from `run()` on: what it moves where, fixed when it starts (never read back from the instance). */
type Move = {
  ref: ChatRef;
  targetId: string;
  sourceName: string;
  targetName: string;
  source: Api;
  check: MoveCheck;
  /** The folder the owner picked (Browse…); else the target's choice. */
  picked: string | null;
  exportId: string;
  /** `before` the commit was sent (it may be abandoned), `committing`, `after` it succeeded. */
  phase: 'before' | 'committing' | 'after';
  /** `move.exportBegin` was sent (an abort must unlock the chat). */
  begun: boolean;
  cancelled: boolean;
  note: string | null;
};

export class MoveChat {
  state = $state<MoveState>('idle');
  check = $state<MoveCheck | null>(null);
  problem = $state<string | null>(null);
  /** The target has the chat but the source still lists its old copy (`markMoved` failed, R2). */
  oldCopyShown = $state(false);

  /** What `prepare` was asked for. */
  private prepared: { ref: ChatRef; targetId: string; folder: string | null } | null = null;
  /** A call is in flight (prepare, run, a retry, askToPush): another one is ignored. */
  private busy = false;
  /** The move in flight. */
  private running: Move | null = null;
  /** The last move (for `retryMarkMoved` and `sendNoteAgain`). */
  private last: Move | null = null;
  private readonly retryMs: number;

  constructor(
    private readonly app: MoveApp,
    o: MoveOptions = {},
  ) {
    this.retryMs = o.retryMs ?? 1_000;
  }

  /** Runs the checks: `move.check` on the source, and `move.target` when the target is on. */
  prepare = async (ref: ChatRef, target: string, folder?: string): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    this.prepared = { ref, targetId: target, folder: folder ?? null };
    this.check = null;
    this.problem = null;
    this.oldCopyShown = false;
    this.state = 'checking';
    try {
      // A target known to be too old is refused before anything is asked.
      const m = this.app.machines.get(target);
      if (m?.info && !supportsMove(m)) {
        return this.fail(`Update ${this.nameOf(target)} to move chats there`);
      }
      const source = await this.api(ref.machineId).request('move.check', {
        sessionId: ref.sessionId,
      });
      const there = this.isOn(target) ? await this.whereOnTarget(target, source) : null;
      this.check = { source, target: there };
      this.state = 'ready';
    } catch (e) {
      this.fail(reason(e));
    } finally {
      this.busy = false;
    }
  };

  /** Moves the prepared chat; a dirty project (or no git repo) moves only with `moveAnyway`. */
  run = async (opts: { moveAnyway: boolean }): Promise<void> => {
    const { prepared, check } = this;
    if (this.busy || !prepared || !check) return;
    if (this.state !== 'ready' && this.state !== 'failed') return;
    const { ref, targetId } = prepared;
    const sourceName = this.nameOf(ref.machineId);
    const targetName = this.nameOf(targetId);
    const refused = this.refusal(
      check.source.git,
      opts.moveAnyway,
      sourceName,
      targetId,
      targetName,
    );
    if (refused) return this.fail(refused);
    const source = this.app.scopes.get(ref.machineId)?.api;
    if (!source) return this.fail(`${sourceName} is not paired`);
    const move: Move = {
      ref,
      targetId,
      sourceName,
      targetName,
      source,
      check,
      picked: prepared.folder,
      exportId: crypto.randomUUID(),
      phase: 'before',
      begun: false,
      cancelled: false,
      note: null,
    };
    // Taken before the first await: a second run() now is ignored.
    this.busy = true;
    this.running = move;
    this.last = move;
    this.problem = null;
    this.oldCopyShown = false;
    this.state = this.isOn(targetId) ? 'moving' : 'starting';
    try {
      await this.carry(move);
    } finally {
      if (this.running === move) {
        this.running = null;
        this.busy = false;
      }
    }
  };

  /**
   * Gives up a move before its commit was sent (e.g. while the target starts):
   * the wait stops, the source unlocks the chat, nothing moved.
   */
  abandon = (): void => {
    const move = this.running;
    if (!move || move.phase !== 'before') return;
    move.cancelled = true;
    this.running = null;
    this.busy = false;
    if (move.begun) this.abort(move);
    this.fail('Move cancelled');
  };

  /** Tries `markMoved` again after it failed (the old copy was still shown). */
  retryMarkMoved = async (): Promise<void> => {
    const move = this.last;
    if (this.busy || !move || !this.oldCopyShown) return;
    this.busy = true;
    try {
      const marked = await this.markMoved(move);
      if (marked === 'failed') return;
      this.oldCopyShown = false;
      if (marked === 'expired') {
        // The chat stays on the source after all: its tab goes back there.
        const there = { machineId: move.targetId, sessionId: move.ref.sessionId };
        this.app.tabs.retarget(there, move.ref);
        this.expired(move);
      }
    } finally {
      this.busy = false;
    }
  };

  /** Sends the first note on the target again, after it failed. */
  sendNoteAgain = async (): Promise<void> => {
    const move = this.last;
    if (this.busy || !move || this.state !== 'noting') return;
    this.busy = true;
    try {
      await this.sendNote(move);
    } finally {
      this.busy = false;
    }
  };

  /** Asks Claude, in the chat on its machine, to commit and push first (§3); moves nothing. */
  askToPush = async (ref: ChatRef): Promise<void> => {
    if (this.busy) return;
    const { prepared, check } = this;
    this.busy = true;
    try {
      const api = this.api(ref.machineId);
      const git =
        check && prepared?.ref.sessionId === ref.sessionId
          ? check.source.git
          : (await api.request('move.check', { sessionId: ref.sessionId })).git;
      const branch = git.kind === 'notRepo' ? null : git.branch;
      const target = prepared ? this.nameOf(prepared.targetId) : 'another machine';
      await api.request('chat.send', {
        sessionId: ref.sessionId,
        text: `Please commit your work and push it to its branch (${branch ?? 'detached HEAD'}), so this chat can move to ${target}. If it isn't ready for that branch, push it to a new WIP branch instead and tell me its name.`,
      });
      this.state = 'idle';
    } catch (e) {
      this.fail(reason(e));
    } finally {
      this.busy = false;
    }
  };

  /** The steps of a move (spec §3–§6), in order. */
  private carry = async (move: Move): Promise<void> => {
    const { ref, targetId, source, exportId } = move;
    let there = move.check.target;
    let folder: string;
    try {
      // 1. An Off target with power control is turned on first (R1).
      await this.bringUp(move);
      if (!supportsMove(this.app.machines.get(targetId))) {
        throw new Error(`Update ${move.targetName} to move chats there`);
      }
      this.state = 'moving';
      const target = this.api(targetId);
      // 2. Where the chat goes, if the target was not on for the checks.
      there ??= await this.whereOnTarget(targetId, move.check.source);
      this.alive(move);
      this.check = { source: move.check.source, target: there };
      folder = move.picked ?? there.folder;
      // 3–5. The export, part by part into the import, then the commit. Each
      // call is idempotent: a lost answer is asked again with the same ids.
      move.begun = true;
      const begun = await this.again(move, ref.machineId, () =>
        source.request('move.exportBegin', { sessionId: ref.sessionId, exportId }),
      );
      const importId = crypto.randomUUID();
      for (let index = 0; index < begun.parts; index++) {
        const { keys } = await this.again(move, ref.machineId, () =>
          source.request('move.exportPart', { exportId, index }),
        );
        const part = { importId, sessionId: ref.sessionId, index, parts: begun.parts, keys };
        await this.again(move, targetId, () => target.request('move.importPart', part));
      }
      move.phase = 'committing';
      const commit = {
        importId,
        sessionId: ref.sessionId,
        cwd: folder,
        from: this.peer(ref.machineId),
      };
      await this.again(move, targetId, () => target.request('move.commit', commit));
      move.phase = 'after';
    } catch (e) {
      // Abandoned: `abandon()` said so already; an export begun since is let go too.
      if (e instanceof Cancelled || move.cancelled) {
        if (move.begun) this.abort(move);
        return;
      }
      // Nothing moved (as far as anyone can tell): the source unlocks the chat.
      await source.request('move.abort', { exportId }).catch(() => {});
      this.fail(
        move.phase === 'committing' && lost(e) ? mayHaveReached(move.targetName) : reason(e),
      );
      return;
    }

    // 7. The old copy on the source is hidden. Before the scheduled sends: a
    // chat that went on there (EXPIRED) stays, its sends with it.
    const marked = await this.markMoved(move);
    if (marked === 'expired') return this.expired(move);
    this.oldCopyShown = marked === 'failed';

    // 6. Scheduled sends follow the chat (R7); 8. so does the draft.
    await this.moveScheduled(move);
    await this.copyDraft(move);
    // 9. The tab follows it.
    this.app.tabs.retarget(ref, { machineId: targetId, sessionId: ref.sessionId });
    // 10. Claude's first note (R4).
    const git = move.check.source.git;
    move.note = moveNote({
      from: move.sourceName,
      to: move.targetName,
      folder,
      origin: git.kind === 'notRepo' ? null : git.origin,
      branch: git.kind === 'notRepo' ? null : git.branch,
      leftBehind: leftBehind(git),
      inUse: !!there?.inUse && folder === there.folder,
    });
    await this.sendNote(move);
  };

  private sendNote = async (move: Move): Promise<void> => {
    if (move.note === null) return;
    try {
      await this.api(move.targetId).request('chat.send', {
        sessionId: move.ref.sessionId,
        text: move.note,
      });
      this.problem = null;
      this.state = 'done';
    } catch (e) {
      this.problem = reason(e);
      this.state = 'noting';
    }
  };

  /** EXPIRED: the chat stays on the source; a new move needs fresh checks. */
  private expired = (move: Move): void => {
    this.check = null;
    this.fail(tooLong(move.sourceName, move.targetName));
  };

  private abort = (move: Move): void => {
    move.source.request('move.abort', { exportId: move.exportId }).catch(() => {});
  };

  /** Stops an abandoned move at its next step. */
  private alive = (move: Move): void => {
    if (move.cancelled) throw new Cancelled();
  };

  private api = (machineId: string): Api => {
    const scope = this.app.scopes.get(machineId);
    if (!scope) throw new Error(`${this.nameOf(machineId)} is not paired`);
    return scope.api;
  };

  private nameOf = (machineId: string): string => machineNameOf(this.app.machines, machineId);

  private peer = (machineId: string): MovePeer => ({ machineId, name: this.nameOf(machineId) });

  private isOn = (machineId: string): boolean => this.app.machines.get(machineId)?.status === 'on';

  private whereOnTarget = (
    targetId: string,
    source: Result<'move.check'>,
  ): Promise<Result<'move.target'>> => {
    const { git, cwd } = source;
    const origin = git.kind === 'notRepo' ? null : git.origin;
    return this.api(targetId).request('move.target', {
      origin,
      repoName: repoNameOf(origin, cwd),
      branch: git.kind === 'notRepo' ? null : git.branch,
    });
  };

  private fail = (problem: string): void => {
    this.problem = problem;
    this.state = 'failed';
  };

  /** Why a move can't start at all (before any service is asked); null when it can. */
  private refusal = (
    git: GitState,
    moveAnyway: boolean,
    sourceName: string,
    targetId: string,
    targetName: string,
  ): string | null => {
    if (!moveAnyway) {
      if (git.kind === 'notRepo') {
        return `This folder isn't a git repo; its files stay on ${sourceName}`;
      }
      const left = leftBehind(git);
      if (left) return left;
    }
    if (!this.isOn(targetId) && !this.app.power.config(targetId)) return `${targetName} is off`;
    return null;
  };

  /** Turns an Off target on (R1) and waits until its link is on; throws when it does not come up. */
  private bringUp = async (move: Move): Promise<void> => {
    const { targetId: id, targetName: name } = move;
    if (this.isOn(id)) return;
    const m = this.app.machines.get(id);
    const shown = m ? this.app.machines.shown(m) : 'unreachable';
    if (shown !== 'off' && shown !== 'starting') throw new Error(`${name} can't be reached`);
    if (shown === 'off') {
      const turnedOn = await this.app.power.turnOn(id);
      this.alive(move);
      if (!turnedOn) throw new Error(this.app.power.error(id) ?? `${name} couldn't be turned on`);
    }
    if (!(await this.waitOn(move, id, START_WAIT_MS))) {
      throw new Error(`${name} didn't come up in 10 minutes`);
    }
  };

  /** Waits until machine `id` is on, at most `ms`; false when it did not come. */
  private waitOn = async (move: Move, id: string, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      this.alive(move);
      if (this.isOn(id)) return true;
      if (Date.now() >= deadline) return false;
      await pause(ON_POLL_MS);
    }
  };

  /**
   * An idempotent call on machine `machineId`: a lost answer is asked again
   * (up to `TRIES` times) once the machine is on again (at most `RECONNECT_WAIT_MS`).
   */
  private again = async <T>(move: Move, machineId: string, call: () => Promise<T>): Promise<T> => {
    for (let i = 1; ; i++) {
      try {
        const answer = await call();
        this.alive(move);
        return answer;
      } catch (e) {
        if (e instanceof Cancelled || i >= TRIES || !lost(e)) throw e;
        await pause(this.retryMs);
        if (!(await this.waitOn(move, machineId, RECONNECT_WAIT_MS))) throw e;
      }
    }
  };

  /** `call`, tried up to `TRIES` times while it fails with an error `retry` accepts. */
  private tried = async <T>(call: () => Promise<T>, retry: (e: unknown) => boolean): Promise<T> => {
    for (let i = 1; ; i++) {
      try {
        return await call();
      } catch (e) {
        if (i >= TRIES || !retry(e)) throw e;
        await pause(this.retryMs);
      }
    }
  };

  /** `markMoved`, tried `TRIES` times; `expired` when the chat went on on the source. */
  private markMoved = async (move: Move): Promise<'done' | 'expired' | 'failed'> => {
    const params = { exportId: move.exportId, to: this.peer(move.targetId) };
    try {
      await this.tried(
        () => move.source.request('move.markMoved', params),
        (e) => !isExpired(e),
      );
      return 'done';
    } catch (e) {
      return isExpired(e) ? 'expired' : 'failed';
    }
  };

  /**
   * The chat's pending scheduled sends, re-created on the target with the same
   * id (R7): one waiting for the limit reset follows the target's own reset, a
   * timed one keeps its time. Each ends up in one place: one the target did
   * not take stays on the source, and one the source would not cancel is
   * cancelled on the target again (only if that fails too is it in both).
   */
  private moveScheduled = async (move: Move): Promise<void> => {
    const { ref, source } = move;
    const target = this.api(move.targetId);
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
      } catch {
        continue; // Not taken by the target: it stays on the source.
      }
      try {
        await this.tried(
          () => source.request('scheduled.cancel', { id: s.id }),
          () => true,
        );
      } catch {
        await target.request('scheduled.cancel', { id: s.id }).catch(() => {});
      }
    }
  };

  /** The composer's unsent text follows the chat. */
  private copyDraft = async (move: Move): Promise<void> => {
    const { ref } = move;
    try {
      const { text } = await move.source.request('drafts.get', { key: ref.sessionId });
      if (text) {
        await this.api(move.targetId).request('drafts.set', { key: ref.sessionId, text });
      }
    } catch {
      // A draft is a convenience; the move is done without it.
    }
  };
}
