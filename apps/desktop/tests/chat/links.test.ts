import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantText from '../../src/lib/components/chat/items/AssistantText.svelte';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn(async (url: string) => /^https?:/.test(url)),
}));
vi.mock('../../src/lib/native', async (original) => ({
  ...(await original<typeof import('../../src/lib/native')>()),
  openExternal,
}));

const item = { id: 'a1', markdown: 'see [docs](https://example.com/docs)', streaming: false };

describe('links in assistant text', () => {
  it('a click opens the link outside pahub and never navigates the webview', async () => {
    openExternal.mockClear();
    const { container } = render(AssistantText, { item });
    const allowed = await fireEvent.click(container.querySelector('a')!);
    expect(allowed).toBe(false); // default prevented
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('a middle click (auxclick) goes the same way', async () => {
    openExternal.mockClear();
    const { container } = render(AssistantText, { item });
    const allowed = await fireEvent(
      container.querySelector('a')!,
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );
    expect(allowed).toBe(false);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });
});
