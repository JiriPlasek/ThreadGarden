import { screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeFileDrop } from '../../src/lib/components/composer/drop';
import { renderChat } from './helpers';

// The desktop app reads dropped images through a Rust command; here a stand-in
// answers like it (base64 for allowed images, `too-large` over 5 MB).
vi.mock('../../src/lib/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/native')>();
  return {
    ...actual,
    readDroppedImage: vi.fn(async (path: string) => {
      if (path.endsWith('big.gif')) throw new Error('too-large');
      return { mediaType: 'image/png', data: 'iVBORw==' };
    }),
  };
});

const pointAt = (el: Element): void => {
  Object.assign(document, { elementFromPoint: () => el });
};

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('native file drop (ruling R24)', () => {
  it('dropped files become @ mentions; images are attached', async () => {
    const { composer } = await renderChat();
    await waitFor(() => expect(composer()).toBeTruthy());
    pointAt(composer());
    await routeFileDrop(
      [
        '/work/alpha/src/app.ts',
        '/elsewhere/My Notes.md',
        '/work/alpha/shot.png',
        '/work/alpha/big.gif',
      ],
      { x: 10, y: 10 },
    );
    await waitFor(() => expect(composer().value).toBe('@src/app.ts @"/elsewhere/My Notes.md" '));
    const thumbs = await screen.findByRole('list', { name: /attached images/i });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/big\.gif.*at most 5 MB/);
  });

  it('a drop outside every composer is ignored', async () => {
    const { composer } = await renderChat();
    pointAt(document.body);
    await routeFileDrop(['/work/alpha/src/app.ts'], { x: 1, y: 1 });
    expect(composer().value).toBe('');
  });
});
