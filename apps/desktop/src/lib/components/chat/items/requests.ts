/**
 * Reading what Claude asks for (permission suggestions, AskUserQuestion
 * questions, ExitPlanMode plans) and building the answer the SDK expects.
 * Inputs come from the CLI and are parsed leniently: anything unexpected
 * degrades to raw JSON in the card instead of failing.
 */
import type { ChatItem } from '@threadgarden/protocol';
import type { ToolCallItem } from '../rows';
import { summarize } from '../tools';

export type RequestItem = Extract<ChatItem, { kind: 'permissionRequest' }>;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── "Always allow" suggestions (SDK PermissionUpdate) ──────────────────────

const DESTINATIONS: Record<string, string> = {
  session: 'for this session',
  localSettings: 'in this project',
  projectSettings: 'in this project (shared settings)',
  userSettings: 'in all projects',
  cliArg: 'for this session',
};

const MODES: Record<string, string> = {
  acceptEdits: 'accept all edits',
  plan: 'switch to plan mode',
  default: 'switch to default mode',
  auto: 'switch to auto mode',
};

const ruleText = (r: unknown): string => {
  if (!isRec(r)) return '';
  const tool = str(r.toolName);
  const content = str(r.ruleContent);
  return content ? `${tool}(${content})` : tool;
};

/** The button text for one suggested rule, e.g. "Always allow Bash(ls:*) in this project". */
export const suggestionLabel = (s: unknown): string => {
  if (!isRec(s)) return 'Always allow';
  const where = DESTINATIONS[str(s.destination)] ?? '';
  const tail = where ? ` ${where}` : '';
  switch (s.type) {
    case 'addRules':
    case 'replaceRules': {
      const rules = Array.isArray(s.rules) ? s.rules.map(ruleText).filter(Boolean) : [];
      if (s.behavior && s.behavior !== 'allow') break;
      return rules.length ? `Always allow ${rules.join(', ')}${tail}` : `Always allow${tail}`;
    }
    case 'setMode': {
      const mode = MODES[str(s.mode)];
      if (mode) return `Yes, and ${mode}${tail}`;
      break;
    }
    case 'addDirectories': {
      const dirs = Array.isArray(s.directories) ? s.directories.map(str).filter(Boolean) : [];
      return `Always allow access to ${dirs.join(', ') || 'these folders'}${tail}`;
    }
  }
  return `Always allow${tail}`;
};

// ── AskUserQuestion ────────────────────────────────────────────────────────

export type QuestionOption = {
  label: string;
  description: string;
  /** A mockup, code snippet or diagram the terminal shows beside the options while this one is focused. */
  preview?: string;
};
export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

/** The questions of an AskUserQuestion input; null when the input has an unknown shape. */
export const parseQuestions = (input: unknown): Question[] | null => {
  if (!isRec(input) || !Array.isArray(input.questions)) return null;
  const out: Question[] = [];
  for (const q of input.questions) {
    if (!isRec(q) || !str(q.question)) return null;
    out.push({
      question: str(q.question),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter(isRec)
        .map((o) => ({
          label: str(o.label),
          description: str(o.description),
          ...(str(o.preview) ? { preview: str(o.preview) } : {}),
        }))
        .filter((o) => o.label),
    });
  }
  return out.length ? out : null;
};

/** One question's answer as the user gave it: chosen labels plus optional own text. */
export type QuestionAnswer = { selected: string[]; other: string };

/**
 * The answer text for one question (SDK `user-input` docs): the chosen
 * option label, or for multi-select the labels joined with ", ". Free text
 * ("Other") is used as the value itself; empty when nothing was given.
 */
export const answerText = (a: QuestionAnswer): string =>
  [...a.selected, ...(a.other.trim() ? [a.other.trim()] : [])].join(', ');

/**
 * `updatedInput` for an answered AskUserQuestion (SDK `user-input` docs,
 * `AskUserQuestionInput` in sdk-tools.d.ts): the original input with its
 * `questions` passed through and `answers` mapping each question's text to
 * the answer string.
 */
export const questionUpdatedInput = (
  input: unknown,
  answers: Record<string, string>,
  annotations: Record<string, QuestionAnnotation> = {},
): Record<string, unknown> => {
  const base = isRec(input) ? input : {};
  return {
    ...base,
    questions: base.questions,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
};

/** What the terminal adds to an answer, keyed by question text: the chosen option's preview. */
export type QuestionAnnotation = { preview: string };

/**
 * The `annotations` of an answer, as the terminal sends them: for a
 * single-choice question answered with an option that has a preview, that
 * preview (so Claude knows which design was picked).
 */
export const questionAnnotations = (
  questions: Question[],
  answers: QuestionAnswer[],
): Record<string, QuestionAnnotation> => {
  const out: Record<string, QuestionAnnotation> = {};
  questions.forEach((q, i) => {
    if (q.multiSelect) return;
    const chosen = q.options.find((o) => o.label === answers[i]?.selected[0]);
    if (chosen?.preview) out[q.question] = { preview: chosen.preview };
  });
  return out;
};

/**
 * "Chat about this": the terminal's note to Claude when the user would
 * rather talk than pick (the question is declined with it), with the
 * questions and whatever was answered so far.
 */
export const clarifyReason = (questions: Question[], answers: QuestionAnswer[]): string =>
  [
    'The user wants to clarify these questions.',
    'This means they may have additional information, context or questions for you.',
    'Take their response into account and then reformulate the questions if appropriate.',
    'Start by asking them what they would like to clarify.',
    '',
    'Questions asked:',
    ...questions.map((q, i) => {
      const a = answers[i] ? answerText(answers[i]) : '';
      return `- "${q.question}"${a ? `\n  Answer: ${a}` : ''}`;
    }),
  ].join('\n');

// ── ExitPlanMode ───────────────────────────────────────────────────────────

/** The plan markdown of an ExitPlanMode request, or null when the input carries none. */
export const planText = (input: unknown): string | null => {
  const plan = isRec(input) ? input.plan : undefined;
  return typeof plan === 'string' && plan.trim() ? plan : null;
};

// ── final state ────────────────────────────────────────────────────────────

/** What a settled card says, e.g. "Always allowed" or "Kept planning". */
export const settledLabel = (
  item: Pick<RequestItem, 'state' | 'variant'>,
  decision?: 'allow' | 'allowAlways' | 'deny',
): string => {
  if (item.state === 'cancelled') return 'Cancelled';
  if (item.state === 'pending') return 'Waiting';
  const allowed = item.state === 'allowed';
  switch (item.variant) {
    case 'question':
      return allowed ? 'Answered' : 'Dismissed';
    case 'plan':
      return allowed ? 'Approved' : 'Kept planning';
    default:
      if (!allowed) return 'Denied';
      return decision === 'allowAlways' ? 'Always allowed' : 'Allowed';
  }
};

/** The request as a tool call, for the tool-row helpers (summary, diffs). */
export const asToolCall = (item: RequestItem): ToolCallItem => ({
  kind: 'toolCall',
  id: item.id,
  toolUseId: item.requestId,
  name: item.toolName,
  input: item.input,
  status: 'running',
  parentToolUseId: null,
});

/** One line naming what was asked: "Bash · ls -la", "a question", "plan approval". */
export const requestWhat = (item: RequestItem): string => {
  if (item.variant === 'question') {
    const first = parseQuestions(item.input)?.[0]?.question;
    return first ?? 'a question';
  }
  if (item.variant === 'plan') return 'plan approval';
  const s = summarize(asToolCall(item), { stats: false });
  return s.target ? `${item.toolName} · ${s.target}` : item.toolName;
};
