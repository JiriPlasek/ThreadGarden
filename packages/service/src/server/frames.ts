import type { WebSocket } from 'ws';
import { RequestSchema, type EventMsg, type Request, type Response } from '@threadgarden/protocol';
import type { HandlerCtx, Router } from './router.js';

/** Sends one message if the socket is still open; a closing socket gets nothing more. */
export const sendFrame = (ws: WebSocket, msg: Response | EventMsg): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/**
 * Serves requests on an authenticated socket: each frame is parsed, routed
 * with `ctx` and answered. Shared by the loopback and the remote servers.
 * Frames that arrive once the socket is closing (e.g. a revoked device) are
 * dropped unanswered.
 */
export const serveFrames = (
  ws: WebSocket,
  opts: {
    router: Router;
    ctx: HandlerCtx;
    /** Methods this socket may call; any other answers `FORBIDDEN`. Default: every method. */
    allows?: (method: string) => boolean;
    report(err: unknown): void;
  },
): void => {
  ws.on('message', (data) => {
    if (ws.readyState !== ws.OPEN) return;
    let req: Request;
    try {
      req = RequestSchema.parse(JSON.parse(String(data)));
    } catch {
      sendFrame(ws, { id: 0, error: { code: 'INVALID_PARAMS', message: 'Malformed request' } });
      return;
    }
    const { id } = req;
    if (opts.allows && !opts.allows(req.method)) {
      sendFrame(ws, {
        id,
        error: { code: 'FORBIDDEN', message: `${req.method} is not available on this connection` },
      });
      return;
    }
    void opts.router
      .dispatch(req, { ...opts.ctx })
      .catch((err: unknown): Response => {
        opts.report(err);
        return { id, error: { code: 'INTERNAL', message: 'Internal error' } };
      })
      .then((res) => sendFrame(ws, res))
      .catch(opts.report);
  });
};

/**
 * The first thing done with any new socket, before it is authenticated: a
 * socket error (a broken frame, an oversized message) drops that socket. An
 * 'error' event without a listener would throw and take the service down.
 */
export const dropOnError = (ws: WebSocket): void => {
  ws.on('error', () => ws.terminate());
};
