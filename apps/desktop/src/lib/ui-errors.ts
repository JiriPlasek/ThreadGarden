/**
 * The window's own errors. The webview keeps no log a user could send, so
 * anything the UI fails to handle is reported to the local service, which
 * writes it, with its stack, to the service log. Reporting never throws.
 */

/** Where an error was caught: a render boundary, the window, a navigation, … */
export type ErrorPlace = 'render' | 'window' | 'promise' | 'navigation' | 'item';

export type ReportUiError = (where: ErrorPlace, error: unknown) => void;

type Request = (
  method: 'ui.error',
  params: { where: string; message: string; stack?: string },
) => Promise<unknown>;

const MESSAGE_MAX = 2000;
const STACK_MAX = 8000;

/** A plain message and, when there is one, the stack (both cut to what the service accepts). */
export const describeError = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) {
    const message = `${error.name}: ${error.message}`.slice(0, MESSAGE_MAX);
    return error.stack ? { message, stack: error.stack.slice(0, STACK_MAX) } : { message };
  }
  let text: string;
  try {
    text = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    text = String(error);
  }
  return { message: (text ?? String(error)).slice(0, MESSAGE_MAX) };
};

/** A reporter that sends to the service through `request`; it also keeps a console copy. */
export const makeReporter =
  (request: Request): ReportUiError =>
  (where, error) => {
    console.error(`Threadgarden (${where}):`, error);
    try {
      void request('ui.error', { where, ...describeError(error) }).catch(() => {});
    } catch {
      // The service may be gone: the console copy is all there is then.
    }
  };

/** Reports the window's uncaught errors and unhandled rejections; returns a stop function. */
export const installErrorReporting = (win: Window, report: ReportUiError): (() => void) => {
  const onError = (e: ErrorEvent): void => report('window', e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent): void => report('promise', e.reason);
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
};
