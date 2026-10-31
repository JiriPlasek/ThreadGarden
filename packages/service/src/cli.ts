/**
 * The `threadgarden` command line of a headless install: `serve` runs the
 * service (bin.ts does that), every other command talks to the running service
 * over loopback with the token from its `service.json`, like the desktop does.
 */
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ResponseSchema,
  methods,
  type Device,
  type MethodName,
  type Params,
  type Result,
} from '@threadgarden/protocol';
import { readDiscovery, type Discovery } from './discovery.js';
import { PAIRING_CODE_TTL_MS } from './machine/devices.js';
import { REMOTE_PORT } from './server/remote-server.js';

export type Command =
  | { kind: 'serve'; headless: boolean; port?: number }
  | { kind: 'pair' }
  | { kind: 'status' }
  | { kind: 'devices' }
  | { kind: 'revoke'; deviceId: string }
  | { kind: 'rename'; name: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const NOT_RUNNING =
  'Threadgarden is not running. Start it with: systemctl --user start threadgarden';
const NOT_LISTENING =
  'Threadgarden is not listening for devices on this machine. It does when it runs headless ' +
  '(threadgarden serve --headless) and has a private network address at start; ' +
  'see journalctl --user -u threadgarden';

export const USAGE = `Usage: threadgarden <command>

Commands:
  serve [--headless [--port <port>]]  Run the service; --headless listens for paired
                                      devices (port ${REMOTE_PORT} unless given) and never exits when idle
  pair                                Show a pairing code for adding this machine in Threadgarden
  status                              Show whether the service runs and where devices reach it
  devices                             List the devices paired with this machine
  revoke <device-id>                  Unpair a device; it is disconnected at once
  rename <name>                       Rename this machine
  help                                Show this help`;

const SERVE_USAGE = 'Usage: threadgarden serve [--headless [--port <port>]]';
/** As `machine.rename` allows. */
const MAX_NAME_LENGTH = 40;
const CALL_TIMEOUT_MS = 10_000;

const usage = (message: string): Command => ({ kind: 'error', message });

const parsePort = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
};

const parseServe = (args: string[]): Command => {
  let headless = false;
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--headless' && !headless) {
      headless = true;
    } else if (arg === '--port' && port === undefined) {
      const parsed = parsePort(args[++i]);
      if (parsed === null) return usage(SERVE_USAGE);
      port = parsed;
    } else {
      return usage(SERVE_USAGE);
    }
  }
  // The port is the device listener's, which only a headless service has.
  if (port !== undefined && !headless) return usage(SERVE_USAGE);
  return port === undefined ? { kind: 'serve', headless } : { kind: 'serve', headless, port };
};

/** The command `argv` (without `node` and the script) asks for; none is `serve`. */
export const parseArgs = (argv: string[]): Command => {
  const [name, ...rest] = argv;
  switch (name) {
    case undefined:
      return { kind: 'serve', headless: false };
    case 'serve':
      return parseServe(rest);
    case 'pair':
    case 'status':
    case 'devices':
      return rest.length === 0 ? { kind: name } : usage(`Usage: threadgarden ${name}`);
    case 'revoke': {
      const [deviceId] = rest;
      return rest.length === 1 && deviceId
        ? { kind: 'revoke', deviceId }
        : usage('Usage: threadgarden revoke <device-id>');
    }
    case 'rename': {
      const machineName = rest.join(' ').trim();
      if (machineName === '') return usage('Usage: threadgarden rename <name>');
      if (machineName.length > MAX_NAME_LENGTH) {
        return usage(`A machine name is at most ${MAX_NAME_LENGTH} characters long`);
      }
      return { kind: 'rename', name: machineName };
    }
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    default:
      return usage(`Unknown command "${name}". Run "threadgarden help" for the list of commands.`);
  }
};

/** The service answered a call with an error. */
class CallError extends Error {}
/** The connection closed (or never authenticated) before the answer came. */
class ConnectionLost extends Error {}
/** The service did not answer in time. */
class CallTimeout extends Error {}

export type LocalConnection = {
  /** The raw result of `method`; rejects when the service answers with an error. */
  call(method: MethodName, params: unknown): Promise<unknown>;
  close(): void;
};

/** A connection to the local service, authenticated with its token as the desktop's is. */
export const connectLocal = (port: number, token: string): Promise<LocalConnection> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, `threadgarden.${token}`, {
      handshakeTimeout: CALL_TIMEOUT_MS,
    });
    type Pending = {
      resolve(v: unknown): void;
      reject(err: Error): void;
      timer: NodeJS.Timeout;
    };
    const pending = new Map<number, Pending>();
    let nextId = 1;
    const failAll = (err: Error): void => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    };
    ws.on('message', (data) => {
      let parsed: ReturnType<typeof ResponseSchema.safeParse>;
      try {
        parsed = ResponseSchema.safeParse(JSON.parse(String(data)));
      } catch {
        return;
      }
      // Events (no id) are not for the command line.
      if (!parsed.success) return;
      const msg = parsed.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new CallError(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.once('error', (err) => {
      const lost = new ConnectionLost(err.message);
      reject(lost);
      failAll(lost);
    });
    ws.once('close', (code) => {
      // 4401: the token is not this service's (a stale service.json).
      const lost = new ConnectionLost(`connection closed (${code})`);
      reject(lost);
      failAll(lost);
    });
    ws.once('open', () =>
      resolve({
        call: (method, params) =>
          new Promise((resolveCall, rejectCall) => {
            if (ws.readyState !== ws.OPEN) {
              rejectCall(new ConnectionLost('connection closed'));
              return;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new CallTimeout(`${method} timed out`));
            }, CALL_TIMEOUT_MS);
            pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      }),
    );
  });

type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>;
type Out = (s: string) => void;

const pad = (n: number): string => String(n).padStart(2, '0');
/** A moment in local time, `YYYY-MM-DD HH:MM`. */
const formatTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const describeDevice = (d: Device): string =>
  [
    d.id,
    d.name,
    `paired ${formatTime(d.createdAt)}`,
    d.lastSeen === null ? 'never seen' : `last seen ${formatTime(d.lastSeen)}`,
  ].join('  ');
const listenAddresses = (d: Discovery): string[] =>
  d.remotePort === undefined ? [] : (d.remoteAddresses ?? []).map((a) => `${a}:${d.remotePort}`);

type ClientCommand = Exclude<Command, { kind: 'serve' | 'help' | 'error' }>;

const runCommand = async (
  cmd: ClientCommand,
  call: Call,
  out: Out,
  discovery: Discovery,
): Promise<number> => {
  switch (cmd.kind) {
    case 'pair': {
      const [address] = listenAddresses(discovery);
      if (address === undefined) {
        out(NOT_LISTENING);
        return 1;
      }
      const machine = await call('machine.get', {});
      const { code } = await call('pairing.create', {});
      out(`Pairing code: ${code} (valid for ${PAIRING_CODE_TTL_MS / 60_000} minutes)`);
      out(`Address: ${address}`);
      out(`Name: ${machine.name}`);
      return 0;
    }
    case 'status': {
      const hello = await call('hello', {
        protocolVersion: PROTOCOL_VERSION,
        client: 'threadgarden-cli',
      });
      const { machine } = hello;
      const mode = machine?.headless ? ', headless' : '';
      out(
        `Threadgarden ${hello.serviceVersion} is running (protocol ${hello.protocolVersion}${mode}).`,
      );
      if (machine) out(`Machine: ${machine.name} (${machine.id})`);
      const addresses = listenAddresses(discovery);
      out(
        addresses.length > 0
          ? `Listening for devices on ${addresses.join(', ')}`
          : 'Not listening for devices.',
      );
      if (machine) out(`Paired devices: ${(await call('devices.list', {})).length}`);
      return 0;
    }
    case 'devices': {
      const devices = await call('devices.list', {});
      if (devices.length === 0) out('No paired devices.');
      for (const d of devices) out(describeDevice(d));
      return 0;
    }
    case 'revoke': {
      const device = (await call('devices.list', {})).find((d) => d.id === cmd.deviceId);
      if (!device || !(await call('devices.revoke', { deviceId: device.id })).revoked) {
        out(`No paired device has the id ${cmd.deviceId}.`);
        return 1;
      }
      out(`Revoked ${device.id} (${device.name}).`);
      return 0;
    }
    case 'rename': {
      const machine = await call('machine.rename', { name: cmd.name });
      out(`This machine is now called "${machine.name}".`);
      return 0;
    }
  }
};

/**
 * Runs a command other than `serve`; resolves to the process exit code: 0 on
 * success, 1 on failure (the service not running included), 2 on wrong usage.
 */
export const runCli = async (
  cmd: Command,
  deps: { dataDir: string; out: Out; connect?: typeof connectLocal },
): Promise<number> => {
  const { out } = deps;
  switch (cmd.kind) {
    case 'help':
      out(USAGE);
      return 0;
    case 'error':
      out(cmd.message);
      return 2;
    case 'serve':
      throw new Error('serve runs the service; bin.ts starts it');
  }
  const discovery = await readDiscovery(deps.dataDir);
  if (!discovery) {
    out(NOT_RUNNING);
    return 1;
  }
  let conn: LocalConnection;
  try {
    conn = await (deps.connect ?? connectLocal)(discovery.port, discovery.token);
  } catch {
    out(NOT_RUNNING);
    return 1;
  }
  const call: Call = async (method, params) =>
    methods[method].result.parse(await conn.call(method, params)) as Result<typeof method>;
  try {
    return await runCommand(cmd, call, out, discovery);
  } catch (err) {
    if (err instanceof ConnectionLost) out(NOT_RUNNING);
    else if (err instanceof CallTimeout) out('Threadgarden did not answer in time.');
    else out(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    conn.close();
  }
};
