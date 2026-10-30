import type { ServiceClient } from '../service/client';

/** The slice of the service client the state modules use (a fake in tests). */
export type Api = Pick<
  ServiceClient,
  'request' | 'on' | 'onReconnect' | 'onOpen' | 'onStatus' | 'status'
>;

/** Fire-and-forget request whose failure is expected to be retried later (e.g. after reconnect). */
export const quietly = (p: Promise<unknown>): void => {
  p.catch(() => {});
};
