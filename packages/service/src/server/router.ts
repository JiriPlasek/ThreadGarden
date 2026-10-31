import {
  methods,
  type MethodName,
  type Params,
  type Request,
  type Response,
  type Result,
} from '@threadgarden/protocol';

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Who is calling. `origin` has no default on purpose: a caller that forgot it
 * must not be taken for this machine's own desktop (local-only methods).
 */
export type HandlerCtx = {
  clientId: string;
  /** `local`: the loopback server (this machine's desktop); `remote`: the TLS listener. */
  origin: 'local' | 'remote';
  /** The paired device behind a remote connection. */
  deviceId?: string;
};
type Handler = (params: unknown, ctx: HandlerCtx) => Promise<unknown>;
type Entry = { handler: Handler; localOnly: boolean };

export class Router {
  private readonly handlers = new Map<string, Entry>();

  constructor(private readonly log: { error(msg: string): void } = { error: () => {} }) {}

  /** `localOnly`: a remote caller gets `FORBIDDEN` before its params are even read. */
  register<M extends MethodName>(
    m: M,
    h: (p: Params<M>, ctx: HandlerCtx) => Promise<Result<M>>,
    opts?: { localOnly?: boolean },
  ): void {
    this.handlers.set(m, { handler: h as Handler, localOnly: opts?.localOnly ?? false });
  }

  async dispatch(req: Request, ctx: HandlerCtx): Promise<Response> {
    const entry = this.handlers.get(req.method);
    const def = (methods as Record<string, (typeof methods)[MethodName] | undefined>)[req.method];
    if (!entry || !def) {
      return {
        id: req.id,
        error: { code: 'METHOD_NOT_FOUND', message: `Unknown method ${req.method}` },
      };
    }
    if (entry.localOnly && ctx.origin !== 'local') {
      return {
        id: req.id,
        error: { code: 'FORBIDDEN', message: `${req.method} is only available on this machine` },
      };
    }
    const parsed = def.params.safeParse(req.params);
    if (!parsed.success) {
      return { id: req.id, error: { code: 'INVALID_PARAMS', message: parsed.error.message } };
    }
    try {
      return { id: req.id, result: await entry.handler(parsed.data, ctx) };
    } catch (err) {
      if (err instanceof ServiceError) {
        return { id: req.id, error: { code: err.code, message: err.message } };
      }
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.log.error(`handler ${req.method} failed: ${detail}`);
      return { id: req.id, error: { code: 'INTERNAL', message: 'Internal error' } };
    }
  }
}
