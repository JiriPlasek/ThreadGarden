import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import { TILE_COLORS, tileColor, tileLetter } from '../../src/lib/components/layout/project-icon';
import type { Api } from '../../src/lib/state/api';
import {
  ICON_RETRY_MS,
  ICON_TTL_MS,
  ProjectIconsState,
} from '../../src/lib/state/project-icons.svelte';
import BucketsHarness from './BucketsHarness.svelte';
import { project, setup } from './harness';

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

/** WCAG relative luminance of `#rrggbb`. */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

describe('letter tiles', () => {
  it('use the first letter or digit of the name, upper-cased', () => {
    expect(tileLetter('pahub')).toBe('P');
    expect(tileLetter('.dotfiles')).toBe('D');
    expect(tileLetter('_tmp-1')).toBe('T');
    expect(tileLetter('42-things')).toBe('4');
    expect(tileLetter('žluťoučký')).toBe('Ž');
    // A disambiguated name ("parent/base") uses the project's own name.
    expect(tileLetter('alpha/app')).toBe('A');
    expect(tileLetter('work/zeta')).toBe('Z');
    expect(tileLetter('---')).toBe('?');
  });

  it('get a stable colour per project id from the palette', () => {
    expect(tileColor('/work/alpha')).toBe(tileColor('/work/alpha'));
    const ids = Array.from({ length: 64 }, (_, i) => `/work/project-${i}`);
    const used = new Set(ids.map(tileColor));
    for (const c of used) expect(TILE_COLORS).toContain(c);
    // The hash spreads projects over the palette.
    expect(used.size).toBeGreaterThan(TILE_COLORS.length / 2);
  });

  it('keep white letters readable on every colour (WCAG AA, 4.5:1)', () => {
    for (const c of TILE_COLORS) {
      expect(1.05 / (luminance(c) + 0.05), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('ProjectIconsState', () => {
  const fakeApi = (answer: (id: string) => Promise<{ dataUrl: string | null }>) => {
    const calls: string[] = [];
    let onOpen: (() => void) | undefined;
    const api = {
      request: (_m: string, p: { projectId: string }) => {
        calls.push(p.projectId);
        return answer(p.projectId);
      },
      onOpen: (cb: () => void) => {
        onOpen = cb;
        return () => {};
      },
    } as unknown as Api;
    return { api, calls, open: () => onOpen?.() };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** Applies answers at once instead of on the next frame. */
  const now = (cb: () => void) => cb();

  it('asks once per project, keeps the answer and asks again after the TTL', async () => {
    let t = 1_000;
    const icons = new ProjectIconsState(() => t, now);
    const f = fakeApi(async (id) => ({ dataUrl: id === 'a' ? ICON : null }));
    icons.init(f.api);
    icons.want('a');
    icons.want('a');
    icons.want('b');
    expect(f.calls).toEqual(['a', 'b']);
    await tick();
    expect(icons.url('a')).toBe(ICON);
    expect(icons.url('b')).toBeNull();
    icons.want('a');
    icons.revalidate();
    expect(f.calls).toEqual(['a', 'b']);
    t += ICON_TTL_MS;
    icons.revalidate();
    expect(f.calls).toEqual(['a', 'b', 'a', 'b']);
  });

  it('retries a failed request after a pause or on reconnect, keeping the tile meanwhile', async () => {
    let t = 1_000;
    const icons = new ProjectIconsState(() => t, now);
    let fail = true;
    const f = fakeApi(async () => {
      if (fail) throw new Error('METHOD_NOT_FOUND');
      return { dataUrl: ICON };
    });
    icons.init(f.api);
    icons.want('a');
    await tick();
    expect(icons.url('a')).toBeNull();
    icons.want('a');
    expect(f.calls).toHaveLength(1);
    t += ICON_RETRY_MS;
    icons.want('a');
    expect(f.calls).toHaveLength(2);
    await tick();
    fail = false;
    f.open();
    expect(f.calls).toHaveLength(3);
    await tick();
    expect(icons.url('a')).toBe(ICON);
  });

  it('applies a burst of answers in one frame; "no icon" for a tile changes nothing', async () => {
    const frames: (() => void)[] = [];
    const icons = new ProjectIconsState(Date.now, (cb) => frames.push(cb));
    const f = fakeApi(async (id) => ({ dataUrl: id.startsWith('icon') ? ICON : null }));
    icons.init(f.api);
    for (const id of ['icon-1', 'icon-2', 'none-1', 'none-2']) icons.want(id);
    await tick();
    expect(frames).toHaveLength(1);
    expect(icons.url('icon-1')).toBeNull();
    frames.shift()!();
    expect(icons.url('icon-1')).toBe(ICON);
    expect(icons.url('icon-2')).toBe(ICON);
    // Only null answers: nothing to show differently, no frame asked for.
    const quiet = new ProjectIconsState(Date.now, (cb) => frames.push(cb));
    quiet.init(fakeApi(async () => ({ dataUrl: null })).api);
    quiet.want('x');
    quiet.want('y');
    await tick();
    expect(frames).toHaveLength(0);
  });
});

describe('project icons in the UI', () => {
  it('the places column shows icons and letter tiles, asking once per project', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [
        project('p1', 'alpha'),
        project('p2', 'beta', { pinned: true }),
      ];
      server.handlers['projects.icon'] = (p) => ({
        dataUrl: (p as { projectId: string }).projectId === 'p1' ? ICON : null,
      });
    });
    const { container } = render(PlacesColumn, { context });
    const alpha = await screen.findByRole('button', { name: /^alpha/ });
    await waitFor(() => expect(alpha.querySelector('img')?.getAttribute('src')).toBe(ICON));
    // Decorative: the name is right next to it.
    expect(alpha.querySelector('img')?.getAttribute('alt')).toBe('');
    const beta = screen.getByRole('button', { name: /^beta/ });
    expect(beta.querySelector('img')).toBeNull();
    const tile = beta.querySelector('[data-project-icon] > span')!;
    expect(tile.getAttribute('data-letter')).toBe('B');
    expect(beta.textContent?.trim()).toBe('beta');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect((tile as HTMLElement).style.backgroundColor).not.toBe('');
    const asked = server
      .calls('projects.icon')
      .map((c) => (c.params as { projectId: string }).projectId);
    expect(asked.sort()).toEqual(['p1', 'p2']);
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('the chat header shows the project icon next to its name', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [project('p1', 'alpha')];
      server.handlers['projects.icon'] = () => ({ dataUrl: ICON });
    });
    await app.places.refresh();
    await app.chats.open('h');
    render(BucketsHarness, { context, props: { chat: app.chats.get('h')! } });
    const banner = screen.getByRole('banner');
    await waitFor(() => expect(within(banner).getByText('alpha')).toBeTruthy());
    await waitFor(() => expect(banner.querySelector('img')?.getAttribute('src')).toBe(ICON));
  });

  it('the quick switcher shows the icon of each hit that names its project', async () => {
    const { context } = await setup((server) => {
      server.handlers['search.quick'] = () => ({
        items: [
          { sessionId: 'a', title: 'with icon', projectName: 'alpha', projectId: 'p1', score: 1 },
          { sessionId: 'b', title: 'old service', projectName: 'beta', score: 0.5 },
        ],
      });
      server.handlers['projects.icon'] = () => ({ dataUrl: ICON });
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox'), 'o');
    const withIcon = await screen.findByRole('option', { name: /with icon/ });
    await waitFor(() => expect(withIcon.querySelector('img')?.getAttribute('src')).toBe(ICON));
    const old = screen.getByRole('option', { name: /old service/ });
    expect(old.querySelector('[data-project-icon]')).toBeNull();
  });
});
