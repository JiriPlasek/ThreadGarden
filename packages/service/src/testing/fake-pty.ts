import type { PtyFactory, PtyProcess } from '../shell/pty.js';

type SpawnOptions = Parameters<PtyFactory>[2];

/** A scripted pseudo-terminal for tests and the mock. Doesn't echo input, like a password prompt. */
export class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly kills: (string | undefined)[] = [];
  echo = false;
  private dataCb: (data: string) => void = () => {};
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => {};

  constructor(readonly spawned: { file: string; args: string[]; o: SpawnOptions }) {}

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.written.push(data);
    if (this.echo) this.dataCb(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  /** Output from the command. */
  emit(data: string): void {
    this.dataCb(data);
  }
  /** The command ended. */
  exit(exitCode: number, signal?: number): void {
    this.exitCb(signal === undefined ? { exitCode } : { exitCode, signal });
  }
}

export const fakePtyFactory = (): { factory: PtyFactory; last(): FakePty } => {
  const made: FakePty[] = [];
  return {
    factory: (file, args, o) => {
      const p = new FakePty({ file, args, o });
      made.push(p);
      return p;
    },
    last: () => {
      const p = made[made.length - 1];
      if (!p) throw new Error('nothing spawned');
      return p;
    },
  };
};
