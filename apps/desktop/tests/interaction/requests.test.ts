import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  parseQuestions,
  questionUpdatedInput,
  suggestionLabel,
} from '../../src/lib/components/chat/items/requests';
import { bashRequest, pushItems, renderChat, request, SID } from './helpers';

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which approach should I take?',
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Small refactor', description: 'Keep the structure' },
        { label: 'Rewrite', description: 'Start the module again' },
      ],
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Lint', description: 'eslint' },
        { label: 'Tests', description: 'vitest' },
        { label: 'Types', description: 'tsc' },
      ],
    },
  ],
};

describe('permission card', () => {
  it('allow always sends suggestionIndex', async () => {
    const { server } = await renderChat({ status: 'needsYou', items: [bashRequest()] });
    const card = await screen.findByRole('group', { name: /permission request/i });
    expect(within(card).getByText('ls -la')).toBeTruthy();

    await userEvent.click(
      within(card).getByRole('button', { name: 'Always allow Bash(ls:*) in this project' }),
    );
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'allowAlways',
      suggestionIndex: 0,
    });

    // The service settles the request; the card keeps its final state.
    pushItems(server, 2, [bashRequest({ state: 'allowed' })]);
    const settled = await screen.findByRole('group', {
      name: /permission request: always allowed/i,
    });
    expect(settled.textContent).toContain('Bash · ls -la');
    expect(screen.queryByRole('button', { name: /^allow$/i })).toBeNull();
  });

  it('allow sends allow; deny with a reason sends the reason', async () => {
    const { server } = await renderChat({
      status: 'needsYou',
      items: [bashRequest(), bashRequest({ requestId: 'r2', id: 'perm:r2' })],
    });
    // One at a time, the oldest first, in the composer's place.
    expect(await screen.findByText('1 of 2 requests')).toBeTruthy();
    const first = await screen.findByRole('group', { name: /permission request/i });
    await userEvent.click(within(first).getByRole('button', { name: /^allow$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'allow',
    });
    pushItems(server, 2, [bashRequest({ state: 'allowed' })]);

    const second = await waitFor(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-docked-request] [data-request-id="r2"]',
      );
      expect(card).toBeTruthy();
      return card!;
    });
    expect(screen.queryByText(/of 2 requests/)).toBeNull();
    await userEvent.click(within(second).getByRole('button', { name: /deny with feedback/i }));
    await userEvent.type(within(second).getByRole('textbox'), 'use git status instead');
    await userEvent.click(within(second).getByRole('button', { name: /^deny$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(2));
    expect(server.calls('chat.respond')[1]!.params).toEqual({
      sessionId: SID,
      requestId: 'r2',
      decision: 'deny',
      reason: 'use git status instead',
    });
  });

  // The chat reads needsYou, not working, while a request waits; its turn still runs.
  it("while a request waits in the composer's place, Stop and Esc end the turn", async () => {
    const { server } = await renderChat({ status: 'needsYou', items: [bashRequest()] });
    const card = await screen.findByRole('group', { name: /permission request/i });
    const docked = document.querySelector<HTMLElement>('[data-docked-request]')!;
    await userEvent.click(within(docked).getByRole('button', { name: /^stop$/i }));
    await waitFor(() => expect(server.calls('chat.interrupt')).toHaveLength(1));
    expect(server.calls('chat.interrupt')[0]!.params).toEqual({ sessionId: SID });

    within(card)
      .getByRole('button', { name: /^allow$/i })
      .focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(server.calls('chat.interrupt')).toHaveLength(2));
    expect(server.calls('chat.respond')).toHaveLength(0);
  });

  it('labels suggestions by rule and destination, never offering bypass', () => {
    expect(
      suggestionLabel({
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        behavior: 'allow',
        destination: 'userSettings',
      }),
    ).toBe('Always allow Bash(npm test:*) in all projects');
    expect(suggestionLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe(
      'Yes, and accept all edits for this session',
    );
    expect(suggestionLabel({ type: 'setMode', mode: 'bypassPermissions' })).not.toMatch(/bypass/i);
  });
});

describe('question form', () => {
  it('question form sends answers as updatedInput', async () => {
    const { server } = await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input: QUESTION_INPUT })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    const submit = within(form).getByRole('button', { name: /^answer$/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(within(form).getByRole('radio', { name: /rewrite/i }));
    await userEvent.click(within(form).getByRole('checkbox', { name: /lint/i }));
    await userEvent.click(within(form).getByRole('checkbox', { name: /types/i }));
    const others = within(form).getAllByRole('textbox', { name: /other answer/i });
    await userEvent.type(others[1]!, 'e2e smoke');
    await userEvent.click(submit);

    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'allow',
      updatedInput: {
        questions: QUESTION_INPUT.questions,
        answers: {
          'Which approach should I take?': 'Rewrite',
          'Which checks should run?': 'Lint, Types, e2e smoke',
        },
      },
    });
    pushItems(server, 2, [
      request({
        toolName: 'AskUserQuestion',
        variant: 'question',
        input: QUESTION_INPUT,
        state: 'allowed',
      }),
    ]);
    const settled = await screen.findByRole('group', { name: /question: answered/i });
    expect(settled.textContent).toContain('Lint, Types, e2e smoke');
  });

  it('free text alone answers a single-choice question', async () => {
    const input = { questions: [QUESTION_INPUT.questions[0]!] };
    const { server } = await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /other answer/i }), 'Neither');
    await userEvent.click(within(form).getByRole('button', { name: /^answer$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toMatchObject({
      decision: 'allow',
      updatedInput: { answers: { 'Which approach should I take?': 'Neither' } },
    });
  });

  it("shows an option's preview beside the options: the hovered one, else the chosen one", async () => {
    const input = {
      questions: [
        {
          question: 'Which layout?',
          header: 'Layout',
          multiSelect: false,
          options: [
            { label: 'Sidebar', description: 'Nav on the left', preview: '[nav] | content' },
            {
              label: 'Top bar',
              description: 'Nav on top',
              preview: '**Top**\n```\n[ nav ]\n  content\n```',
            },
            { label: 'None', description: 'No nav' },
          ],
        },
      ],
    };
    await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    const preview = () => within(form).getByRole('figure');
    // Nothing chosen yet: the first option that has one.
    expect(preview().getAttribute('aria-label')).toBe('Preview: Sidebar');
    expect(preview().textContent).toContain('[nav] | content');

    await userEvent.click(within(form).getByRole('radio', { name: /top bar/i }));
    expect(preview().getAttribute('aria-label')).toBe('Preview: Top bar');
    // Markdown, as the terminal renders it: a fenced block keeps its spacing.
    expect(preview().querySelector('strong')?.textContent).toBe('Top');
    expect(preview().querySelector('pre')?.textContent).toContain('[ nav ]\n  content');

    await userEvent.hover(within(form).getByText('Sidebar'));
    expect(preview().getAttribute('aria-label')).toBe('Preview: Sidebar');
    await userEvent.hover(within(form).getByText('None'));
    expect(preview().textContent).toContain('No preview');
    await userEvent.unhover(within(form).getByText('None'));
    expect(preview().getAttribute('aria-label')).toBe('Preview: Top bar');
  });

  it('a question without previews has no preview panel', async () => {
    await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input: QUESTION_INPUT })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    expect(within(form).queryByRole('figure')).toBeNull();
  });

  it('parses questions leniently and passes the input through', () => {
    expect(parseQuestions({ nope: true })).toBeNull();
    expect(parseQuestions(QUESTION_INPUT)?.[1]?.multiSelect).toBe(true);
    expect(questionUpdatedInput({ ...QUESTION_INPUT, extra: 1 }, { q: 'a' })).toEqual({
      ...QUESTION_INPUT,
      extra: 1,
      answers: { q: 'a' },
    });
  });
});

describe('plan approval', () => {
  const plan = request({
    toolName: 'ExitPlanMode',
    variant: 'plan',
    input: { plan: '## Plan\n\n1. Read the module\n2. Fix it\n' },
  });

  it('renders the plan and approves', async () => {
    const { server } = await renderChat({ status: 'needsYou', items: [plan] });
    const card = await screen.findByRole('group', { name: /plan approval/i });
    expect(within(card).getByRole('heading', { name: 'Plan' })).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'allow',
    });
    pushItems(server, 2, [{ ...plan, state: 'allowed' }]);
    expect(await screen.findByRole('group', { name: /plan approval: approved/i })).toBeTruthy();
  });

  it('keep planning denies with the feedback', async () => {
    const { server } = await renderChat({ status: 'needsYou', items: [plan] });
    const card = await screen.findByRole('group', { name: /plan approval/i });
    await userEvent.type(within(card).getByRole('textbox'), 'also cover the edge case');
    await userEvent.click(within(card).getByRole('button', { name: /keep planning/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'deny',
      reason: 'also cover the edge case',
    });
  });
});

describe('a waiting request takes the composer’s place', () => {
  const composerHidden = (): boolean =>
    screen.queryByRole('textbox', { name: /^message$/i }) === null;

  it('docks the card at the bottom, leaves a line in the list, and gives the composer back', async () => {
    const { server, composer, view } = await renderChat({ status: 'working' });
    await userEvent.type(composer(), 'my draft');
    pushItems(server, 2, [bashRequest()]);

    const docked = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>('[data-docked-request]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(docked).getByRole('group', { name: /permission request/i })).toBeTruthy();
    expect(composerHidden()).toBe(true);
    // Where Claude asked, one line.
    expect(screen.getByText('Waiting for your answer below')).toBeTruthy();

    await userEvent.click(within(docked).getByRole('button', { name: /^allow$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    pushItems(server, 3, [bashRequest({ state: 'allowed' })]);

    // Answered: the composer is back with the draft as it was, and has focus.
    await waitFor(() => expect(composerHidden()).toBe(false));
    expect(composer().value).toBe('my draft');
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    expect(view.container.querySelector('[data-docked-request]')).toBeNull();
    expect(screen.queryByText('Waiting for your answer below')).toBeNull();
  });

  it('a new request takes focus unless the user is typing', async () => {
    const { server, composer } = await renderChat({ status: 'working' });
    pushItems(server, 2, [bashRequest()]);
    const allow = await screen.findByRole('button', { name: /^allow$/i });
    await waitFor(() => expect(document.activeElement).toBe(allow));
    await userEvent.click(allow);
    pushItems(server, 3, [bashRequest({ state: 'allowed' })]);
    await waitFor(() => expect(document.activeElement).toBe(composer()));

    // Typing when the next one comes: it docks but does not take the keys (an
    // Enter meant to send must not press Allow).
    await userEvent.type(composer(), 'typing');
    pushItems(server, 4, [bashRequest({ requestId: 'r2', id: 'perm:r2' })]);
    const next = await screen.findByRole('button', { name: /^allow$/i });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(next);
  });

  it('"Chat about this" declines a question the way the terminal does', async () => {
    const { server, composer } = await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input: QUESTION_INPUT })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    await userEvent.click(within(form).getByRole('radio', { name: /rewrite/i }));
    await userEvent.click(within(form).getByRole('button', { name: 'Chat about this' }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    const params = server.calls('chat.respond')[0]!.params as { decision: string; reason: string };
    expect(params.decision).toBe('deny');
    expect(params.reason).toMatch(/^The user wants to clarify these questions\./);
    expect(params.reason).toContain('Start by asking them what they would like to clarify.');
    expect(params.reason).toContain('- "Which approach should I take?"\n  Answer: Rewrite');
    expect(params.reason).toContain('- "Which checks should run?"');

    pushItems(server, 2, [
      request({
        toolName: 'AskUserQuestion',
        variant: 'question',
        input: QUESTION_INPUT,
        state: 'denied',
      }),
    ]);
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });

  it("an answer carries the chosen option's preview, as the terminal sends it", async () => {
    const input = {
      questions: [
        {
          question: 'Which layout?',
          header: 'Layout',
          multiSelect: false,
          options: [
            { label: 'Sidebar', description: '', preview: '[nav] | content' },
            { label: 'Top bar', description: '' },
          ],
        },
      ],
    };
    const { server } = await renderChat({
      status: 'needsYou',
      items: [request({ toolName: 'AskUserQuestion', variant: 'question', input })],
    });
    const form = await screen.findByRole('form', { name: /question/i });
    await userEvent.click(within(form).getByRole('radio', { name: /sidebar/i }));
    await userEvent.click(within(form).getByRole('button', { name: /^answer$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toMatchObject({
      updatedInput: {
        answers: { 'Which layout?': 'Sidebar' },
        annotations: { 'Which layout?': { preview: '[nav] | content' } },
      },
    });
  });
});
