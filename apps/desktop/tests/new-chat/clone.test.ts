import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  PROJECTS_CAPABILITY,
  type CloneJob,
  type GithubStatus,
  type Repo,
} from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import { CLONE_POLL_MS, watchClone } from '../../src/lib/components/new-chat/clone';
import { M1, machineInfo, project, setupTwoMachines } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const READY: GithubStatus = { ready: true, login: 'jiri', problem: null };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CREATE_IN = '/home/jiri/threadgarden/projects';
const CLONED = `${CREATE_IN}/Plant`;

/** The account's repos, as `github.repos` may list them (not sorted here). */
const REPOS: Repo[] = [
  {
    fullName: 'jiri/old-tool',
    private: false,
    updatedAt: Date.now() - 60 * DAY,
    defaultBranch: 'main',
  },
  {
    fullName: 'Jiri/Plant',
    private: true,
    updatedAt: Date.now() - 2 * HOUR,
    defaultBranch: 'main',
  },
  { fullName: 'acme/site', private: true, updatedAt: Date.now() - 3 * DAY, defaultBranch: 'trunk' },
];

const job = (over: Partial<CloneJob> = {}): CloneJob => ({
  jobId: 'j1',
  state: 'running',
  repo: 'Jiri/Plant',
  path: CLONED,
  error: null,
  ...over,
});

/** What both fake services answer for the dialog and its Clone tab. */
const serveNewChat = (s: FakeServer, o: { createIn: string; sessionId: string }): void => {
  Object.assign(s.handlers, {
    'projects.list': () => [project(o.sessionId === 'new-id' ? 'p9' : 'p1', 'alpha')],
    'chat.models': () => [],
    'chat.commands': () => [],
    'files.suggest': () => [],
    'chat.create': () => ({ sessionId: o.sessionId }),
    'projects.createIn': () => ({ path: o.createIn }),
    'github.status': () => READY,
    'github.repos': () => ({ repos: REPOS }),
    'projects.origins': () => ({ repos: [] }),
    'projects.clone': () => ({ status: 'started', job: job() }),
    'projects.job': () => job({ state: 'done' }),
    'projects.cancel': () => ({}),
  });
};

/** This PC (whose projects include `jiri/plant`) and Ubuntu PC (M1), where the clone runs. */
const twoMachines = (configureRemote?: (s: FakeServer) => void) =>
  setupTwoMachines({
    m1Capabilities: ['remote', PROJECTS_CAPABILITY],
    configure: (s) => {
      serveNewChat(s, { createIn: '/work', sessionId: 'local-id' });
      s.handlers['projects.origins'] = () => ({ repos: ['jiri/plant'] });
    },
    configureRemote: (s) => {
      serveNewChat(s, { createIn: CREATE_IN, sessionId: 'new-id' });
      const info = {
        ...machineInfo(M1, 'ubuntu-pc', ['remote', PROJECTS_CAPABILITY]),
        home: '/home/jiri',
      };
      const hello = s.handlers['hello']!;
      s.handlers['hello'] = (p) => ({ ...(hello(p) as object), machine: info });
      configureRemote?.(s);
    },
  });

type Env = Awaited<ReturnType<typeof twoMachines>>;

/** Opens New chat on Ubuntu PC, on the Clone tab, once its Create in has come. */
const openClone = async (env: Env) => {
  await env.app.places.refresh();
  await waitFor(() => expect(env.app.scopes.get(M1)?.places.projects).toHaveLength(1));
  env.app.interaction.openNewChat();
  render(NewChatDialog, { context: env.context });
  const dialog = await screen.findByRole('dialog', { name: /new chat/i });
  await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /machine/i }), M1);
  await userEvent.click(within(dialog).getByRole('tab', { name: 'Clone' }));
  const where = within(dialog).getByRole('textbox', { name: 'Create in' }) as HTMLInputElement;
  await waitFor(() => expect(where.value).toBe(CREATE_IN));
  return dialog;
};

const message = (dialog: HTMLElement) =>
  within(dialog).getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;

const repoRows = async (dialog: HTMLElement) => {
  await waitFor(() => expect(within(dialog).getAllByRole('radio').length).toBeGreaterThan(0));
  return within(dialog).getAllByRole('radio') as HTMLInputElement[];
};

/** Chooses `Jiri/Plant` and sends `text`. */
const clonePlant = async (dialog: HTMLElement, text = 'hi') => {
  await repoRows(dialog);
  await userEvent.click(within(dialog).getByRole('radio', { name: /Jiri\/Plant/ }));
  await userEvent.type(message(dialog), `${text}{Enter}`);
};

describe('New chat: Clone', () => {
  it("lists the machine's repos newest first, marks those on This PC, filters by search", async () => {
    const env = await twoMachines();
    const dialog = await openClone(env);
    const rows = await repoRows(dialog);
    const text = rows.map((r) => r.closest('label')!.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows.map((r) => r.value)).toEqual(['Jiri/Plant', 'acme/site', 'jiri/old-tool']);
    await waitFor(() => expect(within(dialog).getAllByText('on This PC')).toHaveLength(1));
    expect(rows[0]!.closest('label')!.textContent).toContain('on This PC');
    expect(text[0]).toContain('private');
    expect(text[0]).toContain('2h');
    expect(text[1]).toContain('3d');
    expect(text[2]).toContain('public');
    expect(text[2]).toContain('1mo');
    // Origins are This PC's; the repos are the chosen machine's.
    expect(env.server.calls('projects.origins')).toHaveLength(1);
    expect(env.remote.calls('projects.origins')).toHaveLength(0);
    expect(env.remote.calls('github.repos')).toHaveLength(1);
    expect(env.server.calls('github.repos')).toHaveLength(0);

    await userEvent.type(within(dialog).getByRole('searchbox', { name: /search/i }), 'PLA');
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(['Jiri/Plant']);
  });

  it('gh not ready shows the problem text instead of a list', async () => {
    const problem = 'Run `gh auth login` on ubuntu-pc (over SSH)';
    const env = await twoMachines((s) => {
      s.handlers['github.status'] = () => ({ ready: false, login: null, problem });
    });
    const dialog = await openClone(env);
    expect(await within(dialog).findByText(problem)).toBeTruthy();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    expect(within(dialog).queryByRole('searchbox')).toBeNull();
    expect(env.remote.calls('github.repos')).toHaveLength(0);
  });

  it('cloning polls to done and starts the chat in the clone', async () => {
    let polls = 0;
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job({ state: ++polls < 2 ? 'running' : 'done' });
    });
    const dialog = await openClone(env);
    await clonePlant(dialog, 'look around');
    expect(await within(dialog).findByText('Cloning Jiri/Plant…')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(env.remote.calls('projects.clone')[0]!.params).toEqual({
      createIn: CREATE_IN,
      repo: 'Jiri/Plant',
    });

    await waitFor(() => expect(env.remote.calls('chat.create')).toHaveLength(1), {
      timeout: 4000,
    });
    expect(env.remote.calls('projects.job').map((c) => c.params)).toEqual([
      { jobId: 'j1' },
      { jobId: 'j1' },
    ]);
    expect(env.remote.calls('chat.create')[0]!.params).toMatchObject({
      cwd: CLONED,
      text: 'look around',
    });
    await waitFor(() => expect(env.app.tabs.active).toBe(`${M1}/new-id`));
    expect(env.app.interaction.newChat.open).toBe(false);
    expect(env.server.calls('chat.create')).toHaveLength(0);
  });

  it('an existing clone offers Start there', async () => {
    const there = '/home/jiri/code/Plant';
    const env = await twoMachines((s) => {
      s.handlers['projects.clone'] = () => ({ status: 'existing', path: there });
    });
    const dialog = await openClone(env);
    await clonePlant(dialog);
    const offer = await within(dialog).findByText(`Already cloned in ${there}`, { exact: false });
    expect(env.remote.calls('chat.create')).toHaveLength(0);
    expect(env.remote.calls('projects.job')).toHaveLength(0);

    await userEvent.click(within(offer).getByRole('button', { name: 'Start there' }));
    await waitFor(() => expect(env.remote.calls('chat.create')).toHaveLength(1));
    expect(env.remote.calls('chat.create')[0]!.params).toMatchObject({ cwd: there, text: 'hi' });
    await waitFor(() => expect(env.app.interaction.newChat.open).toBe(false));
  });

  it("a failed clone shows git's reason and keeps the message", async () => {
    const said = "fatal: could not read Username for 'https://github.com'";
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job({ state: 'failed', error: said });
    });
    const dialog = await openClone(env);
    await clonePlant(dialog, 'fix the build');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent?.trim()).toBe(said), {
      timeout: 3000,
    });
    expect(within(dialog).queryByText('Cloning Jiri/Plant…')).toBeNull();
    expect(
      (within(dialog).getByRole('radio', { name: /Jiri\/Plant/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(message(dialog).value).toBe('fix the build');
    expect(env.remote.calls('chat.create')).toHaveLength(0);
  });

  it('closing the dialog while cloning cancels the job', async () => {
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job();
    });
    const dialog = await openClone(env);
    await clonePlant(dialog);
    await within(dialog).findByText('Cloning Jiri/Plant…');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /new chat/i })).toBeNull());
    await waitFor(() => expect(env.remote.calls('projects.cancel')).toHaveLength(1));
    expect(env.remote.calls('projects.cancel')[0]!.params).toEqual({ jobId: 'j1' });

    // Polling has stopped: no further job reads, and no second cancel.
    const polled = env.remote.calls('projects.job').length;
    await new Promise((r) => setTimeout(r, 1300));
    expect(env.remote.calls('projects.job')).toHaveLength(polled);
    expect(env.remote.calls('projects.cancel')).toHaveLength(1);
    expect(env.remote.calls('chat.create')).toHaveLength(0);
  });

  it("a clone whose chat doesn't start offers Start there, as New project does", async () => {
    const env = await twoMachines((s) => {
      s.handlers['chat.create'] = () => {
        throw new RpcFail('SPAWN_FAILED', 'the relay dropped');
      };
    });
    const dialog = await openClone(env);
    await clonePlant(dialog, 'look around');
    const alert = await within(dialog).findByRole('alert', {}, { timeout: 3000 });
    await waitFor(() =>
      expect(alert.textContent).toContain(
        "Jiri/Plant was created, but the chat didn't start: the relay dropped",
      ),
    );

    await userEvent.click(within(alert).getByRole('button', { name: 'Start there' }));
    const existing = within(dialog).getByRole('tab', { name: 'Existing folder' });
    expect(existing.getAttribute('aria-selected')).toBe('true');
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    expect(folder.value).toBe(CLONED);
    await waitFor(() => expect(message(dialog).value).toBe('look around'));
  });

  it('Cancel stops the clone and keeps the message', async () => {
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job();
    });
    const dialog = await openClone(env);
    await clonePlant(dialog, 'hello');
    await within(dialog).findByText('Cloning Jiri/Plant…');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(dialog).queryByText('Cloning Jiri/Plant…')).toBeNull());
    expect(env.remote.calls('projects.cancel').map((c) => c.params)).toEqual([{ jobId: 'j1' }]);
    expect(message(dialog).value).toBe('hello');
    expect(env.remote.calls('chat.create')).toHaveLength(0);
  });

  it('while cloning, the Machine select and the other tabs wait; Cancel frees them', async () => {
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job();
    });
    const dialog = await openClone(env);
    const machine = within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;
    const others = ['Existing folder', 'New project'].map(
      (name) => within(dialog).getByRole('tab', { name }) as HTMLButtonElement,
    );
    expect(machine.disabled).toBe(false);
    expect(others.map((t) => t.disabled)).toEqual([false, false]);

    await clonePlant(dialog);
    await within(dialog).findByText('Cloning Jiri/Plant…');
    expect(machine.disabled).toBe(true);
    expect(others.map((t) => t.disabled)).toEqual([true, true]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(machine.disabled).toBe(false));
    expect(others.map((t) => t.disabled)).toEqual([false, false]);
    expect(env.remote.calls('projects.cancel')).toHaveLength(1);
    expect(machine.value).toBe(M1);
    expect(env.remote.calls('chat.create')).toHaveLength(0);
    expect(env.server.calls('chat.create')).toHaveLength(0);
  });

  it('a clone ended by the machine no longer offering Clone cancels it and frees the dialog', async () => {
    const env = await twoMachines((s) => {
      s.handlers['projects.job'] = () => job();
    });
    const dialog = await openClone(env);
    const machine = within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;
    await clonePlant(dialog);
    await within(dialog).findByText('Cloning Jiri/Plant…');
    expect(machine.disabled).toBe(true);

    // What the machine can do is no longer known (its link dropped, say).
    env.app.machines.get(M1)!.info = null;
    await waitFor(() => expect(env.remote.calls('projects.cancel')).toHaveLength(1));
    const existing = within(dialog).getByRole('tab', { name: 'Existing folder' });
    expect(existing.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(machine.disabled).toBe(false));
    expect(machine.value).toBe(M1);
  });

  it('a search that hides the chosen repo clears the choice', async () => {
    const env = await twoMachines();
    const dialog = await openClone(env);
    await repoRows(dialog);
    await userEvent.click(within(dialog).getByRole('radio', { name: /Jiri\/Plant/ }));
    const search = within(dialog).getByRole('searchbox', { name: /search/i });
    await userEvent.type(search, 'acme');
    await userEvent.type(message(dialog), 'hi{Enter}');
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent?.trim()).toBe(
        'Choose a repo to clone first.',
      ),
    );
    expect(env.remote.calls('projects.clone')).toHaveLength(0);
    await userEvent.clear(search);
    const plant = within(dialog).getByRole('radio', { name: /Jiri\/Plant/ }) as HTMLInputElement;
    expect(plant.checked).toBe(false);
  });

  it('a Create in typed on New project stays when switching to Clone', async () => {
    const env = await twoMachines();
    const dialog = await openClone(env);
    await userEvent.click(within(dialog).getByRole('tab', { name: 'New project' }));
    const where = () =>
      within(dialog).getByRole('textbox', { name: 'Create in' }) as HTMLInputElement;
    await userEvent.clear(where());
    await userEvent.type(where(), '/srv/mine');
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Clone' }));
    await repoRows(dialog);
    expect(where().value).toBe('/srv/mine');
    expect(env.remote.calls('projects.createIn')).toHaveLength(1);
  });
});

describe('watchClone', () => {
  afterEach(() => vi.useRealTimers());

  it('rides out a passing poll failure; three in a row cancel the job', async () => {
    vi.useFakeTimers();
    const api = { job: vi.fn(), cancel: vi.fn(async () => {}) };
    api.job
      .mockRejectedValueOnce(new Error('the relay hiccuped'))
      .mockRejectedValueOnce(new Error('again'))
      .mockResolvedValueOnce(job({ state: 'done' }));
    const healthy = watchClone(api, job());
    await vi.advanceTimersByTimeAsync(3 * CLONE_POLL_MS);
    await expect(healthy.settled).resolves.toMatchObject({ state: 'done' });
    expect(api.job).toHaveBeenCalledTimes(3);
    expect(api.cancel).not.toHaveBeenCalled();

    const down = {
      job: vi.fn(async (): Promise<CloneJob> => {
        throw new Error('gone');
      }),
      cancel: vi.fn(async () => {}),
    };
    const lost = watchClone(down, job());
    const rejected = expect(lost.settled).rejects.toThrow('gone');
    await vi.advanceTimersByTimeAsync(3 * CLONE_POLL_MS);
    await rejected;
    expect(down.job).toHaveBeenCalledTimes(3);
    expect(down.cancel).toHaveBeenCalledTimes(1);
    expect(down.cancel).toHaveBeenCalledWith('j1');
  });
});
