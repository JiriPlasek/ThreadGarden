import { POWER_ERRORS } from '@threadgarden/protocol';
import { ServiceError } from '../server/router.js';

type PowerErrorCode = (typeof POWER_ERRORS)[keyof typeof POWER_ERRORS];

/** A power switch could not be reached or driven. Messages never contain the password. */
export class PowerError extends ServiceError {
  constructor(code: PowerErrorCode, message: string) {
    super(code, message);
    this.name = 'PowerError';
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const causeCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause;
  return cause?.code ?? cause?.errors?.find((e) => e.code)?.code;
};

export type TasmotaClientOptions = {
  address: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Tasmota's HTTP command API (`/cm?cmnd=…`) with user `admin`. */
export class TasmotaClient {
  private readonly address: string;
  private readonly password: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: TasmotaClientOptions) {
    this.address = o.address;
    this.password = o.password;
    this.doFetch = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 5000;
  }

  async command(cmnd: string): Promise<Record<string, unknown>> {
    const url =
      `http://${this.address}/cm?user=admin&password=${encodeURIComponent(this.password)}` +
      `&cmnd=${encodeURIComponent(cmnd)}`;
    let res: Response;
    let text: string;
    try {
      res = await this.doFetch(url, {
        headers: { Referer: `http://${this.address}/` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401) throw new PowerError(POWER_ERRORS.auth, 'The switch refused the password.');
      text = await res.text();
    } catch (err) {
      if (err instanceof PowerError) throw err;
      const name = (err as { name?: string } | null)?.name;
      const code = causeCode(err);
      if (name === 'TimeoutError' || name === 'AbortError' || (code && UNREACHABLE_CODES.has(code))) {
        throw new PowerError(POWER_ERRORS.unreachable, `The switch at ${this.address} did not answer.`);
      }
      if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ECONNABORTED') {
        throw new PowerError(
          POWER_ERRORS.refused,
          `The switch at ${this.address} closed the connection without answering.`,
        );
      }
      throw new PowerError(POWER_ERRORS.unreachable, `The switch at ${this.address} could not be reached.`);
    }
    if (text.trim() === '') {
      throw new PowerError(
        POWER_ERRORS.refused,
        `The switch at ${this.address} answered with nothing.`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PowerError(POWER_ERRORS.notTasmota, `${this.address} did not answer like a Tasmota device.`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new PowerError(POWER_ERRORS.notTasmota, `${this.address} did not answer like a Tasmota device.`);
    }
    const record = body as Record<string, unknown>;
    if (typeof record.WARNING === 'string' && record.WARNING.startsWith('Need user=')) {
      throw new PowerError(POWER_ERRORS.auth, 'The switch refused the password.');
    }
    if (!res.ok) {
      throw new PowerError(POWER_ERRORS.notTasmota, `${this.address} answered HTTP ${res.status}.`);
    }
    return record;
  }

  /** Runs the commands in order on the switch as one `Backlog`. */
  async backlog(cmnds: string[]): Promise<void> {
    await this.command(`Backlog ${cmnds.join(';')}`);
  }
}
