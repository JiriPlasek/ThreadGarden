import { getContext, setContext } from 'svelte';
import type { Decision, RespondParams } from '#lib/state/chats.svelte.js';

/** Answering permission requests, questions and plan approvals from inside the list. */
export type RequestActions = {
  respond: (p: RespondParams, answers?: Record<string, string>) => Promise<void>;
  /** How the user answered a request in this window, if they did. */
  decision: (requestId: string) => Decision | undefined;
};

/** Chat-level actions deep item renderers can trigger (absent outside a chat view). */
export type ChatActions = {
  /** Forks the chat up to this user message; undefined when forking is unavailable. */
  fork?: (itemId: string) => void;
  /** Undefined where requests cannot be answered (read-only renderings). */
  requests?: RequestActions;
};

const KEY = Symbol('threadgarden.chat-actions');

export const setChatActions = (actions: ChatActions): void => {
  setContext(KEY, actions);
};

export const chatActions = (): ChatActions => getContext<ChatActions | undefined>(KEY) ?? {};
