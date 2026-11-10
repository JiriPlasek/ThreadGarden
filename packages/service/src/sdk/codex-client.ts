/** A local Codex app-server connection. No shell, keys, or HTTP client are involved. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import pkg from '../../package.json';
import { launcherTarget } from './claude-path.js';

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};
export interface CodexConnection {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params: Record<string, unknown>): void;
  reply(id: number | string, result: unknown): void;
  reject(id: number | string, message: string): void;
  close(): void;
}
export type ConnectCodex = (
  env: NodeJS.ProcessEnv,
  onMessage: (message: RpcMessage) => void,
  onExit: (error: Error) => void,
) => CodexConnection;

export const findCodex = (env: NodeJS.ProcessEnv): string => {
  const configured = env.THREADGARDEN_CODEX_PATH;
  const win = process.platform === 'win32';
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const dirs = (env[pathKey ?? 'PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => dir.replace(/^"(.*)"$/, '$1'));
  const candidates = [
    ...(configured ? [configured] : []),
    ...dirs.map((dir) => path.join(dir, win ? 'codex.exe' : 'codex')),
    path.join(os.homedir(), '.local', 'bin', win ? 'codex.exe' : 'codex'),
    ...(win
      ? [
          path.join(
            env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
            'Programs',
            'OpenAI',
            'Codex',
            'bin',
            'codex.exe',
          ),
          ...dirs.map((dir) => path.join(dir, 'codex.cmd')),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (win && /\.(cmd|bat)$/i.test(candidate)) {
      const target = launcherTarget(candidate, readFileSync(candidate, 'utf8'));
      if (target && /\.(exe|com|m?js)$/i.test(target) && existsSync(target)) return target;
    } else return candidate;
  }
  throw new Error(
    'Codex CLI was not found. Install Codex, run codex login, or set THREADGARDEN_CODEX_PATH.',
  );
};

const connector =
  (shared: boolean): ConnectCodex =>
  (env, onMessage, onExit) => {
    const executable = findCodex(env);
    const script = /\.m?js$/i.test(executable);
    const proc = spawn(
      script ? process.execPath : executable,
      [
        ...(script ? [executable] : []),
        'app-server',
        ...(shared ? ['proxy'] : ['--listen', 'stdio://']),
      ],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let seq = 0;
    let stopped = false;
    let stderr = '';
    const pending = new Map<
      number,
      {
        resolve(value: Record<string, unknown>): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const write = (message: unknown): void => {
      if (stopped) throw new Error('Codex app-server connection is closed');
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(message as object) })}\n`);
    };
    const finish = (error: Error, graceful = false): void => {
      if (stopped) return;
      stopped = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      lines.close();
      if (graceful) {
        // EOF lets Codex stop its own tool/MCP children before exiting, also on Windows.
        proc.stdin.end();
        const timeout = setTimeout(() => proc.kill(), 2_000);
        timeout.unref();
        proc.once('exit', () => clearTimeout(timeout));
      } else proc.kill();
      onExit(error);
    };
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as RpcMessage & {
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        const p =
          typeof message.id === 'number' && !message.method ? pending.get(message.id) : undefined;
        if (p) {
          pending.delete(message.id as number);
          clearTimeout(p.timer);
          if (message.error) p.reject(new Error(message.error.message ?? 'Codex RPC failed'));
          else p.resolve(message.result ?? {});
        } else onMessage(message);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (error) => finish(error));
    proc.stdin.on('error', (error) => finish(error));
    proc.on('exit', (code) =>
      finish(
        new Error(`Codex app-server exited (${code ?? 'signal'})${stderr ? `: ${stderr}` : ''}`),
      ),
    );
    return {
      request: (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Codex ${method} timed out`));
          }, 30_000);
          pending.set(id, { resolve, reject, timer });
          try {
            write({ id, method, params });
          } catch (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      notify: (method, params) => write({ method, params }),
      reply: (id, result) => write({ id, result }),
      reject: (id, message) => write({ id, error: { code: -32601, message } }),
      close: () => finish(new Error('Codex connection closed'), true),
    };
  };

export const connectCodex = connector(false);
/** Read the existing shared daemon without starting, restarting, or owning its sessions. */
export const connectSharedCodex = connector(true);

export const initializeCodex = async (client: CodexConnection): Promise<void> => {
  await client.request('initialize', {
    clientInfo: { name: 'threadgarden', title: 'Threadgarden', version: pkg.version },
    capabilities: { experimentalApi: true },
  });
  client.notify('initialized', {});
};
