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
    const [first, second] = await screen.findAllByRole('group', { name: /permission request/i });
    await userEvent.click(within(first!).getByRole('button', { name: /^allow$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(1));
    expect(server.calls('chat.respond')[0]!.params).toEqual({
      sessionId: SID,
      requestId: 'r1',
      decision: 'allow',
    });

    await userEvent.click(within(second!).getByRole('button', { name: /deny with feedback/i }));
    await userEvent.type(within(second!).getByRole('textbox'), 'use git status instead');
    await userEvent.click(within(second!).getByRole('button', { name: /^deny$/i }));
    await waitFor(() => expect(server.calls('chat.respond')).toHaveLength(2));
    expect(server.calls('chat.respond')[1]!.params).toEqual({
      sessionId: SID,
      requestId: 'r2',
      decision: 'deny',
      reason: 'use git status instead',
    });
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

describe('needs-you focus', () => {
  it('a new request takes focus unless the user is typing', async () => {
    const { server, composer } = await renderChat({ status: 'working' });
    pushItems(server, 2, [bashRequest()]);
    const allow = await screen.findByRole('button', { name: /^allow$/i });
    await waitFor(() => expect(document.activeElement).toBe(allow));

    await userEvent.click(composer());
    await userEvent.type(composer(), 'typing');
    pushItems(server, 3, [bashRequest({ requestId: 'r2', id: 'perm:r2' })]);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^allow$/i })).toHaveLength(2),
    );
    expect(document.activeElement).toBe(composer());
  });
});
