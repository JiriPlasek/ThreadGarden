import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** `metering: false` is a device without power metering: no ActivePower in its ZbStatus3. */
export type FakeDevice = { name: string | null; on: boolean; watts: number; metering?: boolean };

export type FakeTasmota = {
  /** `127.0.0.1:<port>` */
  address: string;
  close(): Promise<void>;
  /** Every command received, in order (Backlog parts included, after the Backlog itself). */
  commands: string[];
  rules: Record<1 | 2 | 3, { text: string; on: boolean }>;
  timers: Record<number, object>;
  mems: Record<number, string>;
  vars: Record<number, string>;
  /** Keyed by short address, e.g. `0x863B`. On the plug kind the one device is keyed `plug`. */
  devices: Map<string, FakeDevice>;
  utcOffsetMinutes: number;
  /** The global `Timers` flag (default on). */
  timersOn: boolean;
  /** The next `ZbPermitJoin 1` pairs this device. */
  joinNext(dev: {
    id: string;
    name?: string | null;
    on?: boolean;
    watts?: number;
    metering?: boolean;
  }): void;
};

export type FakeTasmotaOptions = {
  password?: string;
  requireReferer?: boolean;
  kind?: 'zigbee' | 'plug';
  version?: string;
  /** Rules longer than this are cut off when written (a small firmware). */
  maxRuleLength?: number;
};

const DEFAULT_TIMER = {
  Enable: 0,
  Mode: 0,
  Time: '00:00',
  Window: 0,
  Days: '0000000',
  Repeat: 0,
  Action: 0,
};

/** Tasmota matches timer keys case-insensitively; the stored form is canonical. */
const TIMER_KEYS: Record<string, string> = Object.fromEntries(
  Object.keys(DEFAULT_TIMER).map((k) => [k.toLowerCase(), k]),
);

/** Splits on `;` outside braces, so JSON arguments survive. */
function splitBacklog(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Tasmota accepts relaxed JSON (`{device:"x",send:{power:1}}`); parse it with lower-cased keys. */
function parseRelaxed(s: string): unknown {
  const lower = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(lower);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), lower(x)]));
    }
    return v;
  };
  try {
    return lower(JSON.parse(s));
  } catch {
    try {
      return lower(JSON.parse(s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')));
    } catch {
      return undefined;
    }
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

export async function startFakeTasmota(o: FakeTasmotaOptions = {}): Promise<FakeTasmota> {
  const kind = o.kind ?? 'zigbee';
  const version =
    o.version ?? (kind === 'zigbee' ? '16.0.0(release-zbbrdgpro)' : '16.0.0(tasmota)');
  const pending: {
    id: string;
    name: string | null;
    on: boolean;
    watts: number;
    metering: boolean;
  }[] = [];
  let setOption83 = true;

  const devices = new Map<string, FakeDevice>();
  if (kind === 'zigbee') {
    devices.set('0x863B', { name: 'UbuntuPlug', on: true, watts: 47 });
    devices.set('0x1234', { name: 'GrowLight', on: true, watts: 0 });
  } else {
    devices.set('plug', { name: null, on: true, watts: 47 });
  }

  const state: FakeTasmota = {
    address: '',
    close: async () => {},
    commands: [],
    rules: { 1: { text: '', on: false }, 2: { text: '', on: false }, 3: { text: '', on: false } },
    timers: {},
    mems: {},
    vars: {},
    devices,
    utcOffsetMinutes: 60,
    timersOn: true,
    joinNext(dev) {
      pending.push({
        id: dev.id,
        name: dev.name ?? null,
        on: dev.on ?? true,
        watts: dev.watts ?? 0,
        metering: dev.metering ?? true,
      });
    },
  };

  const find = (key: string): [string, FakeDevice] | undefined => {
    const k = key.trim().toLowerCase();
    for (const [id, d] of devices) {
      if (id.toLowerCase() === k || d.name?.toLowerCase() === k) return [id, d];
    }
    return undefined;
  };

  const unknown = (input: string) => ({ Command: 'Unknown', Input: input });

  const run = (input: string): Record<string, unknown> => {
    state.commands.push(input);
    const sp = input.indexOf(' ');
    const name = (sp < 0 ? input : input.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : input.slice(sp + 1).trim();
    let m: RegExpMatchArray | null;

    if (name === 'backlog') {
      for (const part of splitBacklog(arg)) run(part);
      return {};
    }
    if (name === 'status') {
      if (arg === '2') return { StatusFWR: { Version: version } };
      if (arg === '7') {
        const now = new Date();
        const local = new Date(now.getTime() + state.utcOffsetMinutes * 60_000);
        return { StatusTIM: { UTC: iso(now), Local: iso(local) } };
      }
      if (arg === '8' && kind === 'plug') {
        const p = devices.get('plug')!;
        return { StatusSNS: { Time: iso(new Date()), ENERGY: { Power: p.on ? p.watts : 0 } } };
      }
      return unknown(input);
    }
    if (name === 'power' && kind === 'plug') {
      const p = devices.get('plug')!;
      if (arg === '0') p.on = false;
      else if (arg === '1') p.on = true;
      else if (arg !== '') return unknown(input);
      return { POWER: p.on ? 'ON' : 'OFF' };
    }
    if (name.startsWith('zb')) {
      if (kind !== 'zigbee') return unknown(input);
      if (name === 'zbstatus1') {
        return {
          ZbStatus1: [...devices].map(([id, d]) => ({
            Device: id,
            ...(d.name ? { Name: d.name } : {}),
          })),
        };
      }
      if (name === 'zbstatus3') {
        const hit = find(arg);
        if (!hit) return { ZbStatus3: 'Unknown device' };
        const [id, d] = hit;
        return {
          ZbStatus3: [
            {
              Device: id,
              ...(d.name ? { Name: d.name } : {}),
              IEEEAddr: '0xA4C138089E5CFFFF',
              ModelId: 'S60ZBTPF',
              Manufacturer: 'SONOFF',
              Endpoints: [1, 242],
              Config: ['P01', 'O01'],
              RMSVoltage: 233.83,
              ...(d.metering === false ? {} : { ActivePower: d.on ? d.watts : 0 }),
              Power: d.on ? 1 : 0,
              Reachable: true,
              LastSeen: 3,
              LinkQuality: 109,
            },
          ],
        };
      }
      if (name === 'zbsend') {
        const j = parseRelaxed(arg) as { device?: unknown; send?: { power?: unknown } } | undefined;
        const hit = typeof j?.device === 'string' ? find(j.device) : undefined;
        if (!hit) return { ZbSend: 'Error' };
        const power = j?.send?.power;
        if (power === 0 || power === 1 || power === '0' || power === '1')
          hit[1].on = Number(power) === 1;
        return { ZbSend: 'Done' };
      }
      if (name === 'zbname') {
        const [id, nm] = arg.split(',').map((s) => s.trim());
        const hit = id ? find(id) : undefined;
        if (!hit || nm === undefined) return { ZbName: 'Error' };
        hit[1].name = nm === '' ? null : nm;
        return { ZbName: { Device: hit[0], Name: nm } };
      }
      if (name === 'zbpermitjoin') {
        if (arg === '1') {
          for (const p of pending.splice(0)) {
            devices.set(p.id, { name: p.name, on: p.on, watts: p.watts, metering: p.metering });
          }
        } else if (arg !== '0') return unknown(input);
        return { ZbPermitJoin: 'Done' };
      }
      return unknown(input);
    }
    if ((m = name.match(/^rule([123])$/))) {
      const n = Number(m[1]) as 1 | 2 | 3;
      const r = state.rules[n];
      if (arg === '0' || arg === '1') r.on = arg === '1';
      else if (arg === '"' || arg === '""')
        r.text = ''; // Tasmota's way to clear a rule
      else if (arg !== '')
        r.text = o.maxRuleLength === undefined ? arg : arg.slice(0, o.maxRuleLength);
      return {
        [`Rule${n}`]: {
          State: r.on ? 'ON' : 'OFF',
          Once: 'OFF',
          StopOnError: 'OFF',
          Length: r.text.length,
          Free: 511 - r.text.length,
          Rules: r.text,
        },
      };
    }
    if ((m = name.match(/^timer(\d+)$/))) {
      const n = Number(m[1]);
      const current = () => ({ ...DEFAULT_TIMER, ...(state.timers[n] ?? {}) });
      if (arg.startsWith('{')) {
        const j = parseRelaxed(arg);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return { [`Timer${n}`]: 'Error' };
        const next: Record<string, unknown> = current();
        for (const [k, v] of Object.entries(j)) {
          const canon = TIMER_KEYS[k];
          if (canon) next[canon] = v;
        }
        state.timers[n] = next;
      } else if (arg === '0') {
        state.timers[n] = { ...DEFAULT_TIMER }; // resets every parameter, as Tasmota does
      } else if (/^\d+$/.test(arg) && Number(arg) >= 1 && Number(arg) <= 16) {
        state.timers[n] = { ...DEFAULT_TIMER, ...(state.timers[Number(arg)] ?? {}) }; // copy Timer<y>
      } else if (arg !== '') return { [`Timer${n}`]: 'Error' };
      return { [`Timer${n}`]: state.timers[n] ?? DEFAULT_TIMER };
    }
    if ((m = name.match(/^(mem|var)(\d+)$/))) {
      const n = Number(m[2]);
      const store = m[1] === 'mem' ? state.mems : state.vars;
      if (arg === '"' || arg === '""') store[n] = '';
      else if (arg !== '') store[n] = arg;
      return { [`${m[1] === 'mem' ? 'Mem' : 'Var'}${n}`]: store[n] ?? '' };
    }
    if (name === 'setoption83') {
      if (arg !== '') setOption83 = arg === '1' || arg.toLowerCase() === 'on';
      return { SetOption83: setOption83 ? 'ON' : 'OFF' };
    }
    if (name === 'timers') {
      if (arg !== '') state.timersOn = arg === '1' || arg.toLowerCase() === 'on';
      return { Timers: state.timersOn ? 'ON' : 'OFF' };
    }
    if (name === 'event') return { Event: 'Done' };
    return unknown(input);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (o.requireReferer && req.headers.referer !== `http://${state.address}/`) {
      req.socket.destroy(); // the real device closes the connection with an empty reply
      return;
    }
    if (url.pathname !== '/cm') {
      res.writeHead(404).end();
      return;
    }
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (o.password !== undefined) {
      const user = url.searchParams.get('user');
      const password = url.searchParams.get('password');
      if (user !== 'admin' || password !== o.password) {
        send(200, { WARNING: 'Need user=<username>&password=<password>' });
        return;
      }
    }
    const cmnd = url.searchParams.get('cmnd');
    if (cmnd === null) {
      send(200, { Command: 'Unknown' });
      return;
    }
    send(200, run(cmnd));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return state;
}
