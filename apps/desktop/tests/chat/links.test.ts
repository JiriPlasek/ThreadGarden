import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import AssistantText from '../../src/lib/components/chat/items/AssistantText.svelte';

const { openExternal, openChatFile } = vi.hoisted(() => ({
  openChatFile: vi.fn(async () => {}),
  openExternal: vi.fn(async (url: string) => /^https?:/.test(url)),
}));
vi.mock('../../src/lib/native', async (original) => ({
  ...(await original<typeof import('../../src/lib/native')>()),
  openExternal,
  openChatFile,
}));

const item = { id: 'a1', markdown: 'see [docs](https://example.com/docs)', streaming: false };

describe('links in assistant text', () => {
  it('a click opens the link outside Threadgarden and never navigates the webview', async () => {
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

  it('the code Copy button never lets the click reach a link or the webview', async () => {
    openExternal.mockClear();
    const { container } = render(AssistantText, {
      item: { id: 'c1', markdown: '```ts\nconst x = 1;\n```', streaming: false },
    });
    // Even if a link ever ended up around it, the click must stop here.
    const button = container.querySelector('[data-copy-code]')!;
    const outer = document.createElement('a');
    outer.href = 'https://evil.example/';
    const reached = vi.fn();
    outer.addEventListener('click', reached);
    container.parentElement!.insertBefore(outer, container);
    outer.appendChild(container);

    const allowed = await fireEvent.click(button);
    expect(allowed).toBe(false); // default prevented
    expect(reached).not.toHaveBeenCalled(); // propagation stopped
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('local file opening', () => {
  const fileItem = {
    kind: 'assistantText' as const,
    id: 'file',
    markdown: '[spec](docs/spec.md)',
    streaming: false,
    ts: 0,
  };
  it('routes local relative links with the chat working folder', async () => {
    openChatFile.mockClear();
    const { container } = render(MessageList, {
      items: [fileItem],
      fileLocation: { cwd: 'C:/project', local: true },
    });
    expect(await fireEvent.click(container.querySelector('a')!)).toBe(false);
    expect(openChatFile).toHaveBeenCalledWith('docs/spec.md', 'C:/project');
  });
  it('reports remote paths instead of opening the same path on this PC', async () => {
    openChatFile.mockClear();
    const { container, findByRole } = render(MessageList, {
      items: [fileItem],
      fileLocation: { cwd: '/remote', local: false },
    });
    await fireEvent.click(container.querySelector('a')!);
    expect(openChatFile).not.toHaveBeenCalled();
    expect((await findByRole('alert')).textContent).toContain('another machine');
  });
  it('shows opener failures', async () => {
    openChatFile.mockRejectedValueOnce(new Error('Missing file'));
    const { container, findByRole } = render(MessageList, {
      items: [fileItem],
      fileLocation: { cwd: 'C:/project', local: true },
    });
    await fireEvent.click(container.querySelector('a')!);
    expect((await findByRole('alert')).textContent).toContain('Missing file');
  });
});
