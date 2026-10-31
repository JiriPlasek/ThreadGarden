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

export type HandlerCtx = { clientId: string };
type Handler = (params: unknown, ctx: HandlerCtx) => Promise<unknown>;

export class Router {
  private readonly handlers = new Map<string, Handler>();

  constructor(private readonly log: { error(msg: string): void } = { error: () => {} }) {}

  register<M extends MethodName>(
    m: M,
    h: (p: Params<M>, ctx: HandlerCtx) => Promise<Result<M>>,
  ): void {
    this.handlers.set(m, h as Handler);
  }

  async dispatch(req: Request, ctx: HandlerCtx): Promise<Response> {
    const handler = this.handlers.get(req.method);
    const def = (methods as Record<string, (typeof methods)[MethodName] | undefined>)[req.method];
    if (!handler || !def) {
      return {
        id: req.id,
        error: { code: 'METHOD_NOT_FOUND', message: `Unknown method ${req.method}` },
      };
    }
    const parsed = def.params.safeParse(req.params);
    if (!parsed.success) {
      return { id: req.id, error: { code: 'INVALID_PARAMS', message: parsed.error.message } };
    }
    try {
      return { id: req.id, result: await handler(parsed.data, ctx) };
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
