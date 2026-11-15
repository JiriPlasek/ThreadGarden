import { describe, expect, it, vi } from 'vitest';
import {
  moveDraft,
  asNow,
  notStartedText,
  sendOf,
  startInMade,
  type NotStarted,
} from '../../src/lib/components/new-chat/start';
import type { MachineScope } from '../../src/lib/state/scope';
import { InteractionState } from '../../src/lib/state/interaction.svelte';
import { outgoing, restoreMessage } from '../../src/lib/components/composer/tags';

const target = { machineId: 'm1' } as MachineScope;
const send = sendOf({
  target,
  draftKey: 'new:project:m1',
  text: 'scaffold it',
  images: [],
  model: 'opus',
  mode: 'default',
});
const made = { name: 'plant', path: '/p/plant', problem: null };

describe('sendOf', () => {
  it('takes the model and a mode other than default, as they are when sent', () => {
    expect(send.chat).toEqual({ text: 'scaffold it', images: [], model: 'opus' });
    const plan = sendOf({ target, draftKey: 'k', text: 't', images: [], model: '', mode: 'plan' });
    expect(plan.chat).toEqual({ text: 't', images: [], permissionMode: 'plan' });
  });
});

describe('startInMade', () => {
  it('starts the chat in the made folder', async () => {
    const start = vi.fn(async () => {});
    expect(await startInMade(send, made, start)).toBeNull();
    expect(start).toHaveBeenCalledWith('/p/plant');
  });

  it('a problem the service reported stops it before the chat, with that reason', async () => {
    const start = vi.fn(async () => {});
    const left = await startInMade(send, { ...made, problem: 'the repo name is taken' }, start);
    expect(left).toEqual({
      machineId: 'm1',
      name: 'plant',
      path: '/p/plant',
      reason: 'the repo name is taken',
      draftKey: 'new:project:m1',
      text: 'scaffold it',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("a chat that doesn't start leaves the folder, with the error as the reason", async () => {
    const left = await startInMade(send, made, async () => {
      throw new Error('the relay dropped');
    });
    expect(left).toMatchObject({ machineId: 'm1', path: '/p/plant', reason: 'the relay dropped' });
    expect(notStartedText(left!)).toBe(
      "plant was created, but the chat didn't start: the relay dropped",
    );
  });
});

describe('moveDraft', () => {
  it('moves the full paste and image registry, and asNow uses the current attachments', () => {
    const interaction = new InteractionState();
    const image = { mediaType: 'image/png', data: 'YWJj', number: 2 };
    const wire = '<pasted_content id="abcd">\nfull log\n</pasted_content id="abcd"> [Image #2]';
    const draft = restoreMessage(wire, [image]);
    interaction.saveAttachments('source', draft);
    interaction.saveDraft('source', outgoing(draft.text, draft.attachments));
    moveDraft(interaction, {
      machineId: 'm1',
      name: 'p',
      path: '/p',
      reason: '',
      draftKey: 'source',
      text: '',
    });
    expect(interaction.cachedAttachments('source')).toBeUndefined();
    expect(interaction.cachedAttachments('new:/p')).toBe(draft);
    const current = asNow({ ...send, target: { interaction } as MachineScope, draftKey: 'new:/p' });
    expect(current.chat.images).toEqual([image]);
    expect(current.chat.text).toContain('full log');
    expect(current.chat.text).not.toContain('[Pasted text');
    interaction.clearDraft('new:/p');
  });
  const left: NotStarted = {
    machineId: 'm1',
    name: 'plant',
    path: '/p/plant',
    reason: 'x',
    draftKey: 'new:project:m1',
    text: 'scaffold it',
  };
  const drafts = (cached: string | undefined) => ({
    cachedDraft: vi.fn(() => (cached === undefined ? undefined : { text: cached, images: [] })),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    moveAttachments: vi.fn(),
  });

  it('moves the message as it is now to the folder’s draft', () => {
    const d = drafts('scaffold it, with tests');
    moveDraft(d, left);
    expect(d.saveDraft).toHaveBeenCalledWith('new:/p/plant', {
      text: 'scaffold it, with tests',
      images: [],
    });
    expect(d.clearDraft).toHaveBeenCalledWith('new:project:m1');
  });

  it('falls back to the message as sent', () => {
    const d = drafts(undefined);
    moveDraft(d, left);
    expect(d.saveDraft).toHaveBeenCalledWith('new:/p/plant', { text: 'scaffold it', images: [] });
  });
});
