/**
 * v1.3 B: scheduled sends (spec §3) — messages the service sends to a chat
 * later. The service stores them and sends them; this mirrors every chat's
 * list (`scheduled.list`, then every `scheduled.changed`) for the list above
 * the composer and the clock badges on chat rows and tabs.
 */
import type { ImageRef, Result, ScheduledSend } from '@pahub/protocol';
import { quietly, type Api } from './api';

/** When a scheduled send goes out: a time, or when the usage limit resets. */
export type SendWhen = { sendAt: number } | { whenLimitResets: true };

/** A send the user still has to think about: waiting for its time, or failed. */
const listed = (s: ScheduledSend): boolean => s.state === 'pending' || s.state === 'failed';

export class ScheduledState {
  items = $state.raw<ScheduledSend[]>([]);

  /** Chat id → its listed sends (pending or failed), in the order they go out. */
  byChat = $derived.by(() => {
    const m = new Map<string, ScheduledSend[]>();
    for (const s of this.items) {
      if (!listed(s)) continue;
      const list = m.get(s.sessionId);
      if (list) list.push(s);
      else m.set(s.sessionId, [s]);
    }
    return m;
  });

  private api: Api | null = null;

  init = (api: Api): void => {
    this.api = api;
    api.on('scheduled.changed', (e) => (this.items = e.items));
    api.onOpen(() => this.load());
    if (api.status === 'open') quietly(this.load());
  };

  forChat = (sessionId: string): ScheduledSend[] => this.byChat.get(sessionId) ?? [];

  create = async (
    sessionId: string,
    text: string,
    images: ImageRef[],
    when: SendWhen,
  ): Promise<ScheduledSend> =>
    this.req().request('scheduled.create', {
      sessionId,
      text,
      ...(images.length > 0 ? { images } : {}),
      ...when,
    });

  /** The send with its images (Edit). */
  get = (id: string): Promise<Result<'scheduled.get'>> =>
    this.req().request('scheduled.get', { id });

  update = (
    id: string,
    patch: { text?: string; images?: ImageRef[] } & Partial<SendWhen>,
  ): Promise<ScheduledSend> => this.req().request('scheduled.update', { id, ...patch });

  cancel = async (id: string): Promise<void> => {
    await this.req().request('scheduled.cancel', { id });
  };

  sendNow = async (id: string): Promise<void> => {
    await this.req().request('scheduled.sendNow', { id });
  };

  private load = async (): Promise<void> => {
    if (!this.api) return;
    this.items = (await this.api.request('scheduled.list', {})).items;
  };

  private req = (): Api => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    return this.api;
  };
}

export const scheduled = new ScheduledState();
