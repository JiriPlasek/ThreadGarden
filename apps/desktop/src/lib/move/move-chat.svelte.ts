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
import { bringUp, pause, waitUntilOn } from '../state/bring-up';
import type { InteractionState, PendingMark } from '../state/interaction.svelte';
import { machineNameOf, type MachinesState } from '../state/machines.svelte';
import type { PowerState } from '../state/power.svelte';
import { chatKey, type ChatRef } from '../state/refs';
import type { Scopes } from '../state/scope';
import type { TabsState } from '../state/tabs.svelte';
import { moveNote } from './note';

/** How long a move waits for an Off target it turned on to come up (ruling R1). */
export const START_WAIT_MS = 10 * 60_000;
/** How long a call whose answer was lost waits for its machine to be on again before it is tried again. */
export const RECONNECT_WAIT_MS = 2 * 60_000;
/**
 * Calls are tried this many times: the idempotent transfer calls and
 * `move.markMoved` after a lost answer (before the old copy is said to be
 * still shown, R2), a scheduled send's cancel on the machine it leaves.
 */
const TRIES = 3;
/** The wait between tries of a failed call. */
const RETRY_MS = 1_000;

export type MoveState =
  'idle' | 'checking' | 'ready' | 'starting' | 'moving' | 'noting' | 'done' | 'failed';

/** What the checks found: the chat's folder on the source, and where it goes on the target (null while the target is not on). */
export type MoveCheck = {
  source: Result<'move.check'>;
  target: Result<'move.target'> | null;
};

/** What the hand-off after the commit needs (also from the moved chat's own view, dialog or not). */
export type MarkApp = {
  scopes: Pick<Scopes, 'get'>;
  machines: Pick<MachinesState, 'get'>;
  tabs: Pick<TabsState, 'retarget'>;
  /**
   * Where a first note that didn't send, and an old copy still shown, are
   * kept, so the chat on the target can offer Send again and Retry.
   */
  interaction: Pick<
    InteractionState,
    'notePending' | 'noteSent' | 'pendingMarks' | 'markPending' | 'markDone' | 'moveNotice'
  >;
};

export type MoveApp = MarkApp & {
  machines: Pick<MachinesState, 'get' | 'shown'>;
  power: Pick<PowerState, 'turnOn' | 'config' | 'error'>;
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

/** `markMoved` answered EXPIRED: the chat went on on the source after its lock ran out. */
const tooLong = (source: string, target: string): string =>
  `The move took too long and ${source} went on with this chat, so it stays there. The copy on ${target} is left as it was.`;

/** The commit's answer never came, and the target did not come back to say. */
const mayHaveReached = (target: string): string =>
  `The move may have reached ${target}; check there before moving again.`;

/** The move was abandoned (`abandon()`): whatever it awaited is dropped. */
class Cancelled extends Error {}

type Waiting = {
  machines: Pick<MachinesState, 'get'>;
  retryMs: number;
  /** Throws when the wait is over (an abandoned move). */
  alive?: () => void;
};

/**
 * An idempotent call on machine `machineId`: a lost answer is asked again
 * (up to `TRIES` times) once the machine is on again (at most `RECONNECT_WAIT_MS`).
 */
const retryLost = async <T>(w: Waiting, machineId: string, call: () => Promise<T>): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      const answer = await call();
      w.alive?.();
      return answer;
    } catch (e) {
      if (e instanceof Cancelled || i >= TRIES || !lost(e)) throw e;
      await pause(w.retryMs);
      if (!(await waitUntilOn(w, machineId, RECONNECT_WAIT_MS))) throw e;
    }
  }
};

/** `call`, tried up to `TRIES` times while it fails with an error `retry` accepts. */
const tried = async <T>(
  retryMs: number,
  call: () => Promise<T>,
  retry: (e: unknown) => boolean,
): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= TRIES || !retry(e)) throw e;
      await pause(retryMs);
    }
  }
};

/**
 * A chat's pending scheduled sends, re-created on `to` with the same id (R7):
 * one waiting for the limit reset follows that machine's own reset, a timed
 * one keeps its time. Each ends up in one place: one `to` did not take stays
 * on `from`, and one `from` would not cancel is cancelled on `to` again
 * (only if that fails too is it in both).
 */
const carrySends = async (
  from: Api,
  to: Api,
  sessionId: string,
  retryMs: number,
): Promise<void> => {
  let items: Result<'scheduled.list'>['items'];
  try {
    ({ items } = await from.request('scheduled.list', { sessionId }));
  } catch {
    return;
  }
  for (const s of items) {
    if (s.state !== 'pending') continue;
    try {
      const images =
        s.imageCount > 0 ? (await from.request('scheduled.get', { id: s.id })).images : undefined;
      await to.request('scheduled.create', {
        sessionId,
        id: s.id,
        text: s.text,
        ...(images ? { images } : {}),
        ...(s.afterLimitReset ? { whenLimitResets: true as const } : { sendAt: s.sendAt }),
      });
    } catch {
      continue; // Not taken: it stays where it was.
    }
    try {
      await tried(
        retryMs,
        () => from.request('scheduled.cancel', { id: s.id }),
        () => true,
      );
    } catch {
      await to.request('scheduled.cancel', { id: s.id }).catch(() => {});
    }
  }
};

/** The composer's unsent text goes along; `clear`: and is gone from `from` once it is on `to`. */
const carryDraft = async (from: Api, to: Api, key: string, clear: boolean): Promise<void> => {
  try {
    const { text } = await from.request('drafts.get', { key });
    if (text) await to.request('drafts.set', { key, text });
    if (text && clear) await from.request('drafts.set', { key, text: '' });
  } catch {
    // A draft is a convenience; the move is done without it.
  }
};

/**
 * `move.markMoved` for the chat now at `there`: `done`, `expired` (the chat
 * went on on its source, where it stays), or `failed` (kept in the app as
 * pending, for Retry). A lost answer is asked again once the source is back.
 */
export const markOldCopy = async (
  app: MarkApp,
  there: ChatRef,
  mark: PendingMark,
  o: { retryMs?: number } = {},
): Promise<'done' | 'expired' | 'failed'> => {
  const source = app.scopes.get(mark.source)?.api;
  try {
    if (!source) throw new Error(`${machineNameOf(app.machines, mark.source)} is not paired`);
    const params = {
      exportId: mark.exportId,
      sessionId: there.sessionId,
      begunAt: mark.begunAt,
      to: mark.to,
    };
    await retryLost({ machines: app.machines, retryMs: o.retryMs ?? RETRY_MS }, mark.source, () =>
      source.request('move.markMoved', params),
    );
    app.interaction.markDone(there);
    return 'done';
  } catch (e) {
    if (isExpired(e)) {
      app.interaction.markDone(there);
      return 'expired';
    }
    app.interaction.markPending(there, { ...mark, problem: reason(e) });
    return 'failed';
  }
};

/**
 * Retry of a pending `move.markMoved` (the old copy is still shown), from the
 * dialog or the moved chat. EXPIRED: the chat stays on its source after all,
 * so its tab, its scheduled sends and its draft go back there (one home).
 */
export const retryOldCopy = async (
  app: MarkApp,
  there: ChatRef,
  o: { retryMs?: number } = {},
): Promise<'done' | 'expired' | 'failed'> => {
  const mark = app.interaction.pendingMarks[chatKey(there)];
  if (!mark) return 'done';
  const marked = await markOldCopy(app, there, mark, o);
  if (marked !== 'expired') return marked;
  const home = { machineId: mark.source, sessionId: there.sessionId };
  app.tabs.retarget(there, home);
  // Its first note on the target is moot now.
  app.interaction.noteSent(there);
  const nameOf = (id: string) => machineNameOf(app.machines, id);
  app.interaction.moveNotice(home, tooLong(nameOf(mark.source), nameOf(there.machineId)));
  const target = app.scopes.get(there.machineId)?.api;
  const source = app.scopes.get(mark.source)?.api;
  if (target && source) {
    await carrySends(target, source, there.sessionId, o.retryMs ?? RETRY_MS);
    await carryDraft(target, source, there.sessionId, true);
  }
  return 'expired';
};

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
  /** When the move began: just before `move.exportBegin` (for `move.markMoved`). */
  begunAt: number;
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

  /** The phase of the move in flight (null: none), for `cancellable`. */
  private phaseNow = $state<Move['phase'] | null>(null);

  /**
   * The target has the chat but the source still lists its old copy
   * (`markMoved` failed, R2). Kept in the app (`pendingMarks`): the chat on
   * the target says so too, and a Retry there clears it here.
   */
  get oldCopyShown(): boolean {
    const move = this.lastMove;
    if (!move || move.phase !== 'after') return false;
    return chatKey(this.thereOf(move)) in this.app.interaction.pendingMarks;
  }

  /** The move in flight can still be given up (`abandon`): its commit was not sent yet. */
  get cancellable(): boolean {
    return this.phaseNow === 'before';
  }

  /** What `prepare` was asked for. */
  private prepared: { ref: ChatRef; targetId: string; folder: string | null } | null = null;
  /** A call is in flight (prepare, run, a retry, askToPush): another one is ignored. */
  private busy = false;
  /** The move in flight. */
  private running: Move | null = null;
  /** The last move (for `retryMarkMoved` and `sendNoteAgain`). */
  private lastMove = $state.raw<Move | null>(null);
  private readonly retryMs: number;

  constructor(
    private readonly app: MoveApp,
    o: MoveOptions = {},
  ) {
    this.retryMs = o.retryMs ?? RETRY_MS;
  }

  /** Runs the checks: `move.check` on the source, and `move.target` when the target is on. */
  prepare = async (ref: ChatRef, target: string, folder?: string): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    this.prepared = { ref, targetId: target, folder: folder ?? null };
    this.check = null;
    this.problem = null;
    this.lastMove = null;
    this.state = 'checking';
    try {
      // A machine known to be too old, either end, is refused before anything is asked.
      for (const id of [ref.machineId, target]) {
        const m = this.app.machines.get(id);
        if (m?.info && !supportsMove(m)) {
          return this.fail(`Update ${this.nameOf(id)} to move chats there`);
        }
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
      begunAt: 0,
      phase: 'before',
      begun: false,
      cancelled: false,
      note: null,
    };
    // Taken before the first await: a second run() now is ignored.
    this.busy = true;
    this.running = move;
    this.phaseNow = 'before';
    this.lastMove = move;
    this.problem = null;
    this.state = this.isOn(targetId) ? 'moving' : 'starting';
    try {
      await this.carry(move);
    } finally {
      if (this.running === move) {
        this.running = null;
        this.phaseNow = null;
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
    this.phaseNow = null;
    this.busy = false;
    if (move.begun) this.abort(move);
    this.fail('Move cancelled');
  };

  /**
   * Tries `markMoved` again after it failed (the old copy was still shown).
   * EXPIRED: the chat stays on the source after all, its tab, scheduled sends
   * and draft with it (`retryOldCopy`).
   */
  retryMarkMoved = async (): Promise<void> => {
    const move = this.lastMove;
    if (this.busy || !move || !this.oldCopyShown) return;
    this.busy = true;
    try {
      const marked = await retryOldCopy(this.app, this.thereOf(move), { retryMs: this.retryMs });
      if (marked === 'expired') this.expired(move);
    } finally {
      this.busy = false;
    }
  };

  /** Sends the first note on the target again, after it failed. */
  sendNoteAgain = async (): Promise<void> => {
    const move = this.lastMove;
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
      await bringUp(this.app, targetId, {
        waitMs: START_WAIT_MS,
        alive: () => this.alive(move),
      });
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
      move.begunAt = Date.now();
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
      this.setPhase(move, 'committing');
      const commit = {
        importId,
        sessionId: ref.sessionId,
        cwd: folder,
        from: this.peer(ref.machineId),
      };
      await this.again(move, targetId, () => target.request('move.commit', commit));
      this.setPhase(move, 'after');
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
    // chat that went on there (EXPIRED) stays, its sends with it. One that
    // fails is kept in the app (`pendingMarks`) for Retry, dialog or not.
    const mark = {
      source: ref.machineId,
      exportId,
      begunAt: move.begunAt,
      to: this.peer(targetId),
      problem: null,
    };
    const marked = await markOldCopy(this.app, this.thereOf(move), mark, {
      retryMs: this.retryMs,
    });
    if (marked === 'expired') return this.expired(move);

    // 6. Scheduled sends follow the chat (R7); 8. so does the draft.
    const target = this.api(targetId);
    await carrySends(source, target, ref.sessionId, this.retryMs);
    await carryDraft(source, target, ref.sessionId, false);
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

  /**
   * Sends Claude's first note on the target. One that fails is handed to the
   * app too (`notePending`), so the chat there can offer Send again after this
   * dialog is gone (§6); either way of sending it again clears it.
   */
  private sendNote = async (move: Move): Promise<void> => {
    const text = move.note;
    if (text === null) return;
    const there = { machineId: move.targetId, sessionId: move.ref.sessionId };
    try {
      await this.api(move.targetId).request('chat.send', { sessionId: there.sessionId, text });
      this.app.interaction.noteSent(there);
      this.problem = null;
      this.state = 'done';
    } catch (e) {
      this.problem = reason(e);
      this.app.interaction.notePending(there, { text, problem: this.problem });
      this.state = 'noting';
    }
  };

  private setPhase = (move: Move, phase: Move['phase']): void => {
    move.phase = phase;
    if (this.running === move) this.phaseNow = phase;
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

  /** An idempotent call of this move on machine `machineId` (`retryLost`). */
  private again = <T>(move: Move, machineId: string, call: () => Promise<T>): Promise<T> =>
    retryLost(this.waiting(move), machineId, call);

  private waiting = (move: Move): Waiting => ({
    machines: this.app.machines,
    retryMs: this.retryMs,
    alive: () => this.alive(move),
  });

  /** The moved chat on its new machine. */
  private thereOf = (move: Move): ChatRef => ({
    machineId: move.targetId,
    sessionId: move.ref.sessionId,
  });
}
