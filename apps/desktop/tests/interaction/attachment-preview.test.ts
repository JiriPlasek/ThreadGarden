import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AttachmentPreview from '../../src/lib/components/composer/AttachmentPreview.svelte';

afterEach(() => vi.restoreAllMocks());

describe('attachment preview first position', () => {
  it('waits for image dimensions and positions before making the preview visible', async () => {
    let loaded = false;
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(() => loaded);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return new DOMRect(0, 0, 320, loaded ? 200 : 18);
    });
    render(AttachmentPreview, {
      image: { mediaType: 'image/png', data: 'YWJj' },
      label: 'Image #1',
      left: 100,
      top: 700,
    });
    const preview = document.querySelector<HTMLElement>('[data-attachment-preview]')!;
    await waitFor(() => expect(preview.style.visibility).toBe('hidden'));
    loaded = true;
    await fireEvent.load(preview.querySelector('img')!);
    expect(preview.style.left).toBe('100px');
    expect(preview.style.top).toBe('494px');
    expect(preview.style.visibility).toBe('visible');
  });

  it('positions text previews immediately without waiting for an image', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 320, 200),
    );
    render(AttachmentPreview, { text: 'pasted log', label: 'Paste #1', left: 100, top: 700 });
    const preview = document.querySelector<HTMLElement>('[data-attachment-preview]')!;
    await waitFor(() => expect(preview.style.top).toBe('494px'));
    expect(preview.style.visibility).toBe('visible');
  });
});
