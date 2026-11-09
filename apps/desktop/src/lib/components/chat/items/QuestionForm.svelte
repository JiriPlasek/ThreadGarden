<script lang="ts">
  import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
  import { untrack } from 'svelte';
  import { renderMarkdown } from '#lib/markdown.js';
  import { chatActions } from '../context';
  import { prettyJson } from '../tools';
  import RequestSettled from './RequestSettled.svelte';
  import {
    answerText,
    clarifyReason,
    parseQuestions,
    questionAnnotations,
    questionUpdatedInput,
    type Question,
    type QuestionAnswer,
    type QuestionOption,
    type RequestItem,
  } from './requests';

  /**
   * Claude's AskUserQuestion as a form (spec §6.4): each question's options
   * (radio or checkboxes) plus free text. The answer goes back as `allow` with
   * `updatedInput.answers` keyed by question text (SDK `user-input` docs).
   * When options carry a `preview` (a mockup, code, a diagram), it shows in a
   * panel beside them, below them in a narrow chat.
   */
  let { item }: { item: RequestItem } = $props();

  const requests = chatActions().requests;
  const questions = $derived(parseQuestions(item.input));
  const uid = $derived(item.requestId.replace(/[^\w-]/g, '_'));

  let answers = $state<QuestionAnswer[]>(
    untrack(() => (parseQuestions(item.input) ?? []).map(() => ({ selected: [], other: '' }))),
  );
  /** Per question, the option under the pointer or keyboard focus (its preview shows). */
  let pointed = $state<(number | null)[]>([]);

  const hasPreview = (q: Question): boolean => q.options.some((o) => o.preview);
  /**
   * The option whose preview shows, as the terminal does for the focused one:
   * the option pointed at, else the (first) chosen one, else the first that has
   * a preview.
   */
  const shownOption = (q: Question, qi: number): QuestionOption | undefined => {
    const at = pointed[qi];
    if (at !== null && at !== undefined) return q.options[at];
    return (
      q.options.find((o) => answers[qi]?.selected.includes(o.label)) ??
      q.options.find((o) => o.preview)
    );
  };
  const point = (qi: number, oi: number | null): void => {
    pointed[qi] = oi;
  };
  /** Free reply for an input this UI cannot read (sent as `response`). */
  let reply = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const complete = $derived(
    questions ? answers.every((a) => answerText(a) !== '') : reply.trim() !== '',
  );

  const choose = (qi: number, label: string, multi: boolean, on: boolean): void => {
    const a = answers[qi];
    if (!a) return;
    const options = questions?.[qi]?.options.map((o) => o.label) ?? [];
    if (multi) {
      const set = new Set(a.selected);
      if (on) set.add(label);
      else set.delete(label);
      a.selected = options.filter((l) => set.has(l));
    } else {
      a.selected = [label];
      a.other = '';
    }
  };

  const typeOther = (qi: number, text: string, multi: boolean): void => {
    const a = answers[qi];
    if (!a) return;
    a.other = text;
    // For a single choice, an own answer replaces the chosen option.
    if (!multi && text.trim()) a.selected = [];
  };

  /**
   * `deny` declines the question; `chat` declines it the way the terminal's
   * "Chat about this" does (Claude asks what to clarify, the composer comes back).
   */
  const send = async (decision: 'allow' | 'deny' | 'chat'): Promise<void> => {
    if (!requests || busy) return;
    busy = true;
    error = null;
    try {
      if (decision === 'deny' || decision === 'chat') {
        await requests.respond({
          requestId: item.requestId,
          decision: 'deny',
          reason:
            decision === 'chat' && questions
              ? clarifyReason(questions, answers)
              : 'The user declined to answer.',
        });
      } else if (questions) {
        const map: Record<string, string> = {};
        questions.forEach((q, i) => (map[q.question] = answerText(answers[i]!)));
        await requests.respond(
          {
            requestId: item.requestId,
            decision: 'allow',
            updatedInput: questionUpdatedInput(
              item.input,
              map,
              questionAnnotations(questions, answers),
            ),
          },
          map,
        );
      } else {
        const base =
          typeof item.input === 'object' && item.input !== null
            ? (item.input as Record<string, unknown>)
            : {};
        await requests.respond({
          requestId: item.requestId,
          decision: 'allow',
          updatedInput: { ...base, answers: {}, response: reply.trim() },
        });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
    // On success the card stays disabled until the service settles the request:
    // a second answer would be refused.
  };

  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    if (complete) void send('allow');
  };

  const btn =
    'inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 disabled:opacity-50';
</script>

{#if item.state !== 'pending'}
  <RequestSettled {item} decision={requests?.decision(item.requestId)} />
{:else}
  <form
    class="rounded-lg border border-amber-500/60 bg-amber-500/5 p-3 text-sm shadow-xs"
    aria-label="Question from Claude"
    data-request-id={item.requestId}
    onsubmit={submit}
  >
    <div class="flex items-center gap-2 text-amber-900 dark:text-amber-200">
      <MessageCircleQuestionIcon class="size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium"
        >Claude has {questions && questions.length > 1 ? 'questions' : 'a question'}</span
      >
    </div>

    {#if questions}
      {#each questions as q, qi (qi)}
        {@const a = answers[qi]!}
        {@const previewed = hasPreview(q)}
        <fieldset class="mt-3" disabled={busy || !requests}>
          <legend class="flex items-baseline gap-2">
            {#if q.header}
              <span
                class="rounded bg-amber-500/15 px-1.5 text-[0.6875rem] font-medium text-amber-900 dark:text-amber-200"
                >{q.header}</span
              >
            {/if}
            <span class="font-medium">{q.question}</span>
          </legend>
          <div class={previewed ? 'mt-1.5 flex flex-wrap items-start gap-3' : 'mt-1.5'}>
            <div class={previewed ? 'min-w-56 flex-1 space-y-1' : 'space-y-1'}>
              {#each q.options as o, oi (oi)}
                <label
                  class="hover:bg-muted/60 flex cursor-pointer items-start gap-2 rounded px-1.5 py-1"
                  onmouseenter={() => point(qi, oi)}
                  onmouseleave={() => point(qi, null)}
                >
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name="q-{uid}-{qi}"
                    class="mt-0.5 accent-amber-600"
                    checked={a.selected.includes(o.label)}
                    data-autofocus={qi === 0 && oi === 0 ? '' : undefined}
                    onchange={(e) => choose(qi, o.label, q.multiSelect, e.currentTarget.checked)}
                    onfocus={() => point(qi, oi)}
                    onblur={() => point(qi, null)}
                  />
                  <span class="min-w-0">
                    <span class="font-medium">{o.label}</span>
                    {#if o.description}
                      <span class="text-muted-foreground block text-xs">{o.description}</span>
                    {/if}
                  </span>
                </label>
              {/each}
              <div class="flex items-center gap-2 px-1.5">
                <span class="text-muted-foreground shrink-0 text-xs">Other:</span>
                <input
                  class="bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
                  aria-label="Other answer: {q.question}"
                  placeholder="Type your own answer"
                  value={a.other}
                  oninput={(e) => typeOther(qi, e.currentTarget.value, q.multiSelect)}
                />
              </div>
            </div>
            {#if previewed}
              {@const shown = shownOption(q, qi)}
              <figure
                class="bg-background min-w-64 flex-1 self-stretch rounded-md border p-2"
                aria-label="Preview: {shown?.label ?? ''}"
              >
                {#if shown?.preview}
                  <!-- Markdown in a monospace box, as the terminal renders it. Links stay inert: one would navigate the window. -->
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <div
                    class="md max-h-80 overflow-auto font-mono text-xs leading-snug [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap"
                    onclick={(e) => {
                      if ((e.target as Element).closest('a')) e.preventDefault();
                    }}
                  >
                    <!-- Sanitized by DOMPurify (markdown.ts). -->
                    {@html renderMarkdown(shown.preview)}
                  </div>
                {:else}
                  <p class="text-muted-foreground text-xs">No preview for this option</p>
                {/if}
              </figure>
            {/if}
          </div>
        </fieldset>
      {/each}
    {:else}
      <pre
        class="bg-background mt-2 max-h-48 overflow-auto rounded-md border px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{prettyJson(
          item.input,
        )}</pre>
      <input
        class="bg-background mt-2 h-7 w-full rounded-md border px-2 text-xs"
        aria-label="Other answer: your reply"
        placeholder="Type your reply"
        data-autofocus
        bind:value={reply}
        disabled={busy || !requests}
      />
    {/if}

    {#if requests}
      <div class="mt-3 flex items-center gap-1.5">
        <button
          type="submit"
          class="{btn} border-amber-600 bg-amber-500 text-amber-950 hover:bg-amber-400"
          disabled={busy || !complete}>Answer</button
        >
        {#if questions}
          <button
            type="button"
            class="{btn} bg-background hover:bg-muted"
            title="Decline the question and talk it over with Claude instead"
            disabled={busy}
            onclick={() => send('chat')}>Chat about this</button
          >
        {/if}
        <button
          type="button"
          class="{btn} bg-background hover:bg-muted"
          disabled={busy}
          onclick={() => send('deny')}>Dismiss</button
        >
      </div>
      {#if error}
        <p class="text-destructive mt-2 text-xs" role="alert">{error}</p>
      {/if}
    {/if}
  </form>
{/if}
