// The pseudo-terminal behind `!` commands. The native module is loaded at run time so a machine
// where it can't load still works, just without the `shell` capability.

/** The prebuilt PTY package (N-API, with platform packages); esbuild keeps it external. */
export const PTY_PACKAGE = '@lydell/node-pty';

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  o: {
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
    name: 'xterm-256color';
  },
) => PtyProcess;

type NodePty = { spawn: (file: string, args: string[], o: object) => PtyProcess };

/** The PTY factory, or undefined (with one warning) when the module can't load. */
export const loadPty = async (log: { warn(m: string): void }): Promise<PtyFactory | undefined> => {
  try {
    const mod = (await import(/* @vite-ignore */ PTY_PACKAGE)) as Partial<NodePty> & {
      default?: Partial<NodePty>;
    };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== 'function') throw new Error('no spawn function');
    return (file, args, o) => spawn(file, args, o);
  } catch (err) {
    log.warn(
      `! commands are off: ${PTY_PACKAGE} could not load (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
};
