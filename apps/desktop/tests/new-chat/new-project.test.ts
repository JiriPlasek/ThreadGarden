import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { PROJECTS_CAPABILITY, type GithubStatus } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import { LOCAL, M1, machineInfo, project, setupTwoMachines } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const READY: GithubStatus = { ready: true, login: 'jiri', problem: null };

/** What a fake service answers for the dialog: its projects, the composer, and the projects methods. */
const serveNewChat = (
  s: FakeServer,
  o: { projects: ReturnType<typeof project>[]; createIn: string; sessionId: string },
): void => {
  Object.assign(s.handlers, {
    'projects.list': () => o.projects,
    'chat.models': () => [],
    'chat.commands': () => [],
    'files.suggest': () => [],
    'chat.create': () => ({ sessionId: o.sessionId }),
    'projects.createIn': () => ({ path: o.createIn }),
    'github.status': () => READY,
    'projects.create': (p: unknown) => {
      const { createIn, name } = p as { createIn: string; name: string };
      return { path: `${createIn}/${name}`, repo: null, problem: null };
    },
    'folders.list': (p: unknown) => {
      const path = (p as { path: string }).path;
      return {
        path,
        parent: '/',
        folders: [{ name: 'plant', path: '/srv/plant', git: true }],
      };
    },
  });
};

/** This PC and Ubuntu PC (M1, home `/home/jiri`), which supports projects unless `older`. */
const twoMachines = (
  o: {
    older?: boolean;
    configure?: (s: FakeServer) => void;
    configureRemote?: (s: FakeServer) => void;
  } = {},
) =>
  setupTwoMachines({
    m1Capabilities: o.older ? ['remote'] : ['remote', PROJECTS_CAPABILITY],
    configure: (s) => {
      serveNewChat(s, {
        projects: [project('p1', 'alpha')],
        createIn: '/work',
        sessionId: 'local-id',
      });
      o.configure?.(s);
    },
    configureRemote: (s) => {
      serveNewChat(s, {
        projects: [project('p9', 'tg-cli')],
        createIn: '/home/jiri/threadgarden/projects',
        sessionId: 'new-id',
      });
      const caps = o.older ? ['remote'] : ['remote', PROJECTS_CAPABILITY];
      const info = { ...machineInfo(M1, 'ubuntu-pc', caps), home: '/home/jiri' };
      const hello = s.handlers['hello']!;
      s.handlers['hello'] = (p) => ({ ...(hello(p) as object), machine: info });
      o.configureRemote?.(s);
    },
  });

/** Opens the New chat dialog, on Ubuntu PC when `onM1`. */
const open = async (env: Awaited<ReturnType<typeof twoMachines>>, onM1 = true) => {
  await env.app.places.refresh();
  await waitFor(() => expect(env.app.scopes.get(M1)?.places.projects).toHaveLength(1));
  env.app.interaction.openNewChat();
  render(NewChatDialog, { context: env.context });
  const dialog = await screen.findByRole('dialog', { name: /new chat/i });
  if (onM1) {
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /machine/i }), M1);
  }
  return dialog;
};

const message = (dialog: HTMLElement) => within(dialog).getByRole('textbox', { name: /message/i });

/** Switches to New project and waits for its Create in. */
const newProject = async (dialog: HTMLElement, createIn: string) => {
  await userEvent.click(within(dialog).getByRole('tab', { name: 'New project' }));
  const where = within(dialog).getByRole('textbox', { name: 'Create in' }) as HTMLInputElement;
  await waitFor(() => expect(where.value).toBe(createIn));
  return within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
};

describe('New chat tabs', () => {
  it('three tabs with the exact names; Existing folder by default', async () => {
    const dialog = await open(await twoMachines(), false);
    const tabs = within(within(dialog).getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      'Existing folder',
      'New project',
      'Clone',
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByRole('combobox', { name: /folder/i })).toBeTruthy();
  });

  it('Browse… on another machine opens the folder browser and starts the chat in the picked folder', async () => {
    const env = await twoMachines();
    const dialog = await open(env);
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    await waitFor(() => expect(folder.value).toBe('/work/tg-cli'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder on Ubuntu PC' });
    // It starts at the selected folder.
    await waitFor(() =>
      expect(env.remote.calls('folders.list')[0]!.params).toEqual({ path: '/work/tg-cli' }),
    );
    await userEvent.click(await within(browser).findByRole('button', { name: /plant/ }));
    await waitFor(() =>
      expect(env.remote.calls('folders.list').at(-1)!.params).toEqual({ path: '/srv/plant' }),
    );
    await waitFor(() =>
      expect(
        (within(browser).getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await userEvent.click(within(browser).getByRole('button', { name: 'Use this folder' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /choose a folder/i })).toBeNull(),
    );
    expect(folder.value).toBe('/srv/plant');
    expect(within(folder).getByRole('option', { name: '/srv/plant' })).toBeTruthy();

    await userEvent.type(message(dialog), 'hi{Enter}');
    await waitFor(() => expect(env.remote.calls('chat.create')).toHaveLength(1));
    expect(env.remote.calls('chat.create')[0]!.params).toMatchObject({ cwd: '/srv/plant' });
    expect(env.server.calls('chat.create')).toHaveLength(0);
  });

  it('Escape in the folder browser closes only the browser', async () => {
    const dialog = await open(await twoMachines());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    await screen.findByRole('dialog', { name: 'Choose a folder on Ubuntu PC' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /choose a folder/i })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: /new chat/i })).toBeTruthy();
  });

  it('New project creates the project on the chosen machine, then starts the chat in it', async () => {
    const env = await twoMachines();
    const dialog = await open(env);
    const name = await newProject(dialog, '/home/jiri/threadgarden/projects');
    await userEvent.type(name, 'plant-logger');
    const github = within(dialog).getByRole('checkbox', { name: /create a github repo/i });
    expect((github as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect((github as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(github);
    expect(
      within(dialog).getByText('→ /home/jiri/threadgarden/projects/plant-logger'),
    ).toBeTruthy();

    await userEvent.type(message(dialog), 'scaffold it{Enter}');
    await waitFor(() => expect(env.remote.calls('chat.create')).toHaveLength(1));
    expect(env.remote.calls('projects.create')[0]!.params).toEqual({
      createIn: '/home/jiri/threadgarden/projects',
      name: 'plant-logger',
      github: true,
    });
    expect(env.remote.calls('chat.create')[0]!.params).toMatchObject({
      cwd: '/home/jiri/threadgarden/projects/plant-logger',
      text: 'scaffold it',
    });
    await waitFor(() => expect(env.app.tabs.active).toBe(`${M1}/new-id`));
    expect(env.app.interaction.newChat.open).toBe(false);
  });

  it('an invalid name blocks sending and says why', async () => {
    const env = await twoMachines();
    const dialog = await open(env);
    const name = await newProject(dialog, '/home/jiri/threadgarden/projects');
    await userEvent.type(name, 'plant logger');
    expect(within(dialog).getByText('Letters, digits, . _ - only (at most 100)')).toBeTruthy();
    await userEvent.type(message(dialog), 'hi{Enter}');
    await userEvent.clear(name);
    await userEvent.type(name, 'plant.');
    expect(within(dialog).getByText("A name can't end with '.'")).toBeTruthy();
    await userEvent.type(message(dialog), '{Enter}');
    expect(env.remote.calls('projects.create')).toHaveLength(0);
    expect((message(dialog) as HTMLTextAreaElement).value).toBe('hi');

    await userEvent.clear(name);
    await userEvent.type(name, 'plant');
    expect(within(dialog).queryByText(/only \(at most 100\)|can't end/)).toBeNull();
  });

  it('GitHub tick disabled with the reason when gh is not ready', async () => {
    const problem = 'Run `gh auth login` on ubuntu-pc (over SSH)';
    const dialog = await open(
      await twoMachines({
        configureRemote: (s) => {
          s.handlers['github.status'] = () => ({ ready: false, login: null, problem });
        },
      }),
    );
    await newProject(dialog, '/home/jiri/threadgarden/projects');
    const github = within(dialog).getByRole('checkbox', {
      name: /create a github repo/i,
    }) as HTMLInputElement;
    await waitFor(() => expect(github.title).toBe(problem));
    expect(github.disabled).toBe(true);
    expect(github.checked).toBe(false);
  });

  it('an error from projects.create shows in the alert; fields and text stay', async () => {
    const said =
      'plant-logger already exists in ~/code. Use the Existing folder tab to start there.';
    const env = await twoMachines({
      configureRemote: (s) => {
        s.handlers['projects.create'] = () => {
          throw new RpcFail('EXISTS', said);
        };
      },
    });
    const dialog = await open(env);
    const name = await newProject(dialog, '/home/jiri/threadgarden/projects');
    await userEvent.type(name, 'plant-logger');
    await userEvent.type(message(dialog), 'hi{Enter}');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent?.trim()).toBe(said));
    expect(name.value).toBe('plant-logger');
    expect((message(dialog) as HTMLTextAreaElement).value).toBe('hi');
    expect(env.remote.calls('chat.create')).toHaveLength(0);
  });

  it('a project made but the chat failed offers Start there, which keeps the message', async () => {
    const env = await twoMachines({
      configureRemote: (s) => {
        s.handlers['chat.create'] = () => {
          throw new RpcFail('SPAWN_FAILED', 'the relay dropped');
        };
      },
    });
    const dialog = await open(env);
    const name = await newProject(dialog, '/home/jiri/threadgarden/projects');
    await userEvent.type(name, 'plant-logger');
    await userEvent.type(message(dialog), 'scaffold it{Enter}');
    const alert = await within(dialog).findByRole('alert');
    await waitFor(() =>
      expect(alert.textContent).toContain(
        "plant-logger was created, but the chat didn't start: the relay dropped",
      ),
    );

    await userEvent.click(within(alert).getByRole('button', { name: 'Start there' }));
    const existing = within(dialog).getByRole('tab', { name: 'Existing folder' });
    expect(existing.getAttribute('aria-selected')).toBe('true');
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    expect(folder.value).toBe('/home/jiri/threadgarden/projects/plant-logger');
    await waitFor(() => expect((message(dialog) as HTMLTextAreaElement).value).toBe('scaffold it'));
  });

  it('a project made without its repo offers Start there with the reason', async () => {
    const env = await twoMachines({
      configureRemote: (s) => {
        s.handlers['projects.create'] = () => ({
          path: '/home/jiri/threadgarden/projects/plant-logger',
          repo: null,
          problem: 'the repo name is taken',
        });
      },
    });
    const dialog = await open(env);
    const name = await newProject(dialog, '/home/jiri/threadgarden/projects');
    await userEvent.type(name, 'plant-logger');
    await userEvent.type(message(dialog), 'scaffold it{Enter}');
    const alert = await within(dialog).findByRole('alert');
    await waitFor(() =>
      expect(alert.textContent).toContain(
        "plant-logger was created, but the chat didn't start: the repo name is taken",
      ),
    );
    expect(within(alert).getByRole('button', { name: 'Start there' })).toBeTruthy();
    expect(env.remote.calls('chat.create')).toHaveLength(0);
  });

  it('an older machine (no projects capability) disables New project, Clone and Browse… with the update hint', async () => {
    const dialog = await open(await twoMachines({ older: true }));
    for (const el of [
      within(dialog).getByRole('tab', { name: 'New project' }),
      within(dialog).getByRole('tab', { name: 'Clone' }),
      within(dialog).getByRole('button', { name: 'Browse…' }),
    ]) {
      expect((el as HTMLButtonElement).disabled).toBe(true);
      expect(el.getAttribute('title')).toBe('Update Ubuntu PC to use this');
    }
  });

  it("the preview uses the machine's separator", async () => {
    const env = await twoMachines({
      configure: (s) => {
        const info = { ...machineInfo(LOCAL, 'my-host'), platform: 'win32' };
        const hello = s.handlers['hello']!;
        s.handlers['hello'] = (p) => ({ ...(hello(p) as object), machine: info });
        s.handlers['projects.createIn'] = () => ({ path: 'C:\\Users\\jiri\\code\\' });
      },
    });
    const dialog = await open(env, false);
    const name = await newProject(dialog, 'C:\\Users\\jiri\\code\\');
    await userEvent.type(name, 'plant');
    expect(within(dialog).getByText('→ C:\\Users\\jiri\\code\\plant')).toBeTruthy();
  });

  it("This PC's New project uses This PC's service", async () => {
    const env = await twoMachines();
    const dialog = await open(env, false);
    const name = await newProject(dialog, '/work');
    await userEvent.type(name, 'plant-logger');
    expect(within(dialog).getByText('→ /work/plant-logger')).toBeTruthy();
    await userEvent.type(message(dialog), 'hi{Enter}');
    await waitFor(() => expect(env.server.calls('chat.create')).toHaveLength(1));
    expect(env.server.calls('projects.create')).toHaveLength(1);
    expect(env.server.calls('projects.create')[0]!.params).toMatchObject({ createIn: '/work' });
    expect(env.server.calls('chat.create')[0]!.params).toMatchObject({ cwd: '/work/plant-logger' });
    expect(env.remote.calls('projects.create')).toHaveLength(0);
    await waitFor(() => expect(env.app.tabs.active).toBe(`${LOCAL}/local-id`));
  });
});
