import type { FolderListing } from '@threadgarden/protocol';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FolderBrowser from '../../src/lib/components/new-chat/FolderBrowser.svelte';
import type { ProjectsApi } from '../../src/lib/projects';

const listing = (path: string, parent: string | null, folders: FolderListing['folders'] = []) => ({
  path,
  parent,
  folders,
});

const fakeApi = (over: Partial<ProjectsApi> = {}): ProjectsApi =>
  ({
    list: vi.fn(async (p: string) => listing(p, null)),
    complete: vi.fn(async () => []),
    makeFolder: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    ...over,
  }) as unknown as ProjectsApi;

const setup = (api: ProjectsApi, start = '/home/j') => {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  render(FolderBrowser, { api, machineName: 'Ubuntu', start, onPick, onCancel });
  return { onPick, onCancel };
};

describe('FolderBrowser', () => {
  it('opens on start and lists folders with git marks', async () => {
    const api = fakeApi({
      list: vi.fn(async () =>
        listing('/home/j', '/home', [
          { name: 'plant', path: '/home/j/plant', git: true },
          { name: 'docs', path: '/home/j/docs', git: false },
        ]),
      ),
    });
    setup(api);
    expect(await screen.findByText('plant')).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith('/home/j');
    expect(screen.getByText('Choose a folder on Ubuntu')).toBeTruthy();
    expect(screen.getAllByTestId('git-mark')).toHaveLength(1);
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('/home/j');
  });

  it('typing a path and Enter loads it; Tab completes a single match', async () => {
    const api = fakeApi({ complete: vi.fn(async () => ['/srv/projects']) });
    setup(api);
    const box = (await screen.findByLabelText('Path')) as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe('/home/j'));
    await userEvent.clear(box);
    await userEvent.type(box, '/srv/pro{Tab}');
    await waitFor(() => expect(box.value).toBe('/srv/projects'));
    expect(api.complete).toHaveBeenCalledWith('/srv/pro');
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/srv/projects'));
  });

  it('Tab fills the longest common prefix of several matches', async () => {
    const api = fakeApi({ complete: vi.fn(async () => ['/srv/plant-a', '/srv/plant-b']) });
    setup(api);
    const box = (await screen.findByLabelText('Path')) as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe('/home/j'));
    await userEvent.type(box, '{Tab}');
    await waitFor(() => expect(box.value).toBe('/srv/plant-'));
  });

  it(".. and breadcrumb use the service's parent, never a client-built path", async () => {
    const api = fakeApi({
      list: vi.fn(async (p: string) =>
        p === 'C:\\Users\\j' ? listing(p, 'C:\\Users') : listing(p, 'C:\\'),
      ),
    });
    setup(api, 'C:\\Users\\j');
    await userEvent.click(await screen.findByRole('button', { name: '..' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('C:\\Users'));
  });

  it('New folder makes it and opens it', async () => {
    const api = fakeApi({ makeFolder: vi.fn(async () => 'C:\\Users\\j\\fresh') });
    setup(api, 'C:\\Users\\j');
    await userEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    await userEvent.type(screen.getByLabelText('Folder name'), 'fresh{Enter}');
    await waitFor(() => expect(api.makeFolder).toHaveBeenCalledWith('C:\\Users\\j', 'fresh'));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('C:\\Users\\j\\fresh'));
  });

  it('an error shows in place and keeps the last listing', async () => {
    const api = fakeApi({
      list: vi.fn(async (p: string) => {
        if (p === '/nope') throw new Error('No such folder');
        return listing(p, null, [{ name: 'plant', path: `${p}/plant`, git: false }]);
      }),
    });
    setup(api);
    const box = (await screen.findByLabelText('Path')) as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe('/home/j'));
    await screen.findByText('plant');
    await userEvent.clear(box);
    await userEvent.type(box, '/nope{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('No such folder');
    expect(screen.getByText('plant')).toBeTruthy();
  });

  it('Use this folder returns the current path; Cancel cancels', async () => {
    const api = fakeApi();
    const { onPick, onCancel } = setup(api);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(onPick).toHaveBeenCalledWith('/home/j');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
