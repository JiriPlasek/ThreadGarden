import { getContext, setContext } from 'svelte';

/** Chat-level actions deep item renderers can trigger (absent outside a chat view). */
export type ChatActions = {
  /** Forks the chat up to this user message; undefined when forking is unavailable. */
  fork?: (itemId: string) => void;
};

const KEY = Symbol('pahub.chat-actions');

export const setChatActions = (actions: ChatActions): void => {
  setContext(KEY, actions);
};

export const chatActions = (): ChatActions => getContext<ChatActions | undefined>(KEY) ?? {};
