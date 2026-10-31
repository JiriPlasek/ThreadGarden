<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { RANGES } from '#lib/state/analytics.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import BarList from './BarList.svelte';
  import ChartCard from './ChartCard.svelte';
  import ColumnChart, { type Series } from './ColumnChart.svelte';
  import DataTable from './DataTable.svelte';
  import { compact, full, hourLabel, longDay, shortDay, WEEKDAYS_LONG } from './format';
  import Heatmap from './Heatmap.svelte';

  /**
   * The Analytics view (v1.3 §4), in the main pane like a chat: one row of
   * controls (range, project) scoping everything below, KPI tiles, then the
   * charts. Every chart has a table view; colors are the validated
   * categorical slots and one sequential ramp, stepped for light and dark.
   * A refetch keeps the previous numbers on screen, dimmed.
   */
  const { analytics, places } = useApp();

  onMount(() => analytics.watch());

  const data = $derived(analytics.data);
  const week = $derived(data?.bucket === 'week');
  const days = $derived(data?.activity.map((a) => a.day) ?? []);

  const projects = $derived(
    [...places.projects].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );
  const projectName = $derived(
    analytics.projectId === null
      ? null
      : (places.projects.find((p) => p.projectId === analytics.projectId)?.displayName ??
          data?.projects.find((p) => p.projectId === analytics.projectId)?.name ??
          analytics.projectId),
  );

  const rangeText = $derived.by(() => {
    if (!data) return '';
    const span =
      data.from === data.to ? shortDay(data.to) : `${shortDay(data.from)} – ${shortDay(data.to)}`;
    const label = RANGES.find((r) => r.value === data.range)?.label ?? '';
    return data.range === 'all' ? `All time (${span})` : `Last ${label.toLowerCase()} (${span})`;
  });

  /**
   * Categorical slots in fixed order; a model keeps its slot across ranges
   * and projects (`modelSlots`). `Other` (the models past the fourth) is the
   * de-emphasis gray.
   */
  const SLOTS = ['var(--viz-s1)', 'var(--viz-s2)', 'var(--viz-s3)', 'var(--viz-s4)'];
  const OTHER = 'Other';

  const messageSeries = $derived<Series[]>([
    {
      name: 'Messages',
      color: 'var(--viz-s1)',
      values: data?.activity.map((a) => a.messages) ?? [],
    },
  ]);
  const chatsLine = $derived<Series>({
    name: 'Chats started',
    color: 'var(--viz-s2)',
    values: data?.activity.map((a) => a.chatsStarted) ?? [],
  });
  const tokenSeries = $derived.by((): Series[] => {
    if (!data) return [];
    const models = data.tokens.models;
    const slots = analytics.modelSlots(
      models.filter((m) => m !== OTHER),
      SLOTS.length,
    );
    return models.map((model, i) => ({
      name: model,
      color: model === OTHER ? 'var(--viz-other)' : SLOTS[slots[i] ?? 0]!,
      values: data.tokens.days.map((d) => d.values[i] ?? 0),
    }));
  });

  const kpis = $derived(
    data
      ? [
          { label: 'Chats', value: compact(data.kpis.chats), title: full(data.kpis.chats) },
          {
            label: 'Messages',
            value: compact(data.kpis.messages),
            title: full(data.kpis.messages),
          },
          {
            label: 'Output tokens',
            value: compact(data.kpis.outputTokens),
            title: full(data.kpis.outputTokens),
          },
          { label: 'Active days', value: String(data.kpis.activeDays), title: '' },
          {
            label: 'Busiest project',
            value: data.kpis.busiestProject?.name ?? '—',
            title: data.kpis.busiestProject
              ? `${full(data.kpis.busiestProject.messages)} messages`
              : '',
          },
        ]
      : [],
  );

  const dayName = (day: string): string => (week ? longDay(day, true) : longDay(day));
  const filterTo = (projectId: string): void =>
    analytics.setProject(analytics.projectId === projectId ? null : projectId);
</script>

<section
  class="viz-root flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]"
  aria-labelledby="analytics-heading"
>
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-5">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id="analytics-heading" class="text-lg font-semibold tracking-tight">Analytics</h2>
      <p class="text-muted-foreground text-sm">
        {rangeText}{projectName ? ` · ${projectName}` : ' · All projects'}
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Analytics filters">
      <div class="bg-muted/60 flex rounded-md border p-0.5" role="radiogroup" aria-label="Range">
        {#each RANGES as r (r.value)}
          <button
            type="button"
            role="radio"
            aria-checked={analytics.range === r.value}
            class={cn(
              'focus-visible:ring-ring/50 rounded px-2.5 py-1 text-xs outline-none focus-visible:ring-2',
              analytics.range === r.value
                ? 'bg-background text-foreground font-medium shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onclick={() => analytics.setRange(r.value)}>{r.label}</button
          >
        {/each}
      </div>
      <label class="text-muted-foreground flex items-center gap-2 text-xs">
        Project
        <select
          class="bg-background text-foreground focus-visible:ring-ring/50 h-7 max-w-56 rounded-md border px-2 text-xs outline-none focus-visible:ring-2"
          value={analytics.projectId ?? ''}
          onchange={(e) => analytics.setProject(e.currentTarget.value || null)}
        >
          <option value="">All projects</option>
          {#each projects as p (p.projectId)}
            <option value={p.projectId}>{p.displayName}</option>
          {/each}
          {#if analytics.projectId !== null && !projects.some((p) => p.projectId === analytics.projectId)}
            <option value={analytics.projectId}>{projectName}</option>
          {/if}
        </select>
      </label>
      {#if projectName}
        <button
          type="button"
          class="bg-muted hover:bg-muted/70 focus-visible:ring-ring/50 flex h-7 items-center gap-1 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2"
          onclick={() => analytics.setProject(null)}
        >
          {projectName}<XIcon class="size-3.5" aria-hidden="true" /><span class="sr-only"
            >: show all projects</span
          >
        </button>
      {/if}
    </div>

    {#if analytics.error}
      <p role="alert" class="text-destructive text-sm">{analytics.error}</p>
    {/if}
    {#if data && data.pending > 0}
      <p role="status" class="text-muted-foreground text-xs">
        Still gathering the statistics of {full(data.pending)} older
        {data.pending === 1 ? 'chat' : 'chats'}; the numbers grow until it is done.
      </p>
    {/if}

    {#if !data}
      {#if !analytics.error}
        <p class="text-muted-foreground text-sm" role="status">Loading analytics…</p>
      {/if}
    {:else}
      <div class={cn('flex flex-col gap-4 transition-opacity', analytics.loading && 'opacity-60')}>
        <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {#each kpis as k (k.label)}
            <div class="bg-background rounded-lg border px-4 py-3">
              <dt class="text-muted-foreground text-xs">{k.label}</dt>
              <dd class="mt-1 truncate text-2xl font-semibold" title={k.title || k.value}>
                {k.value}
              </dd>
            </div>
          {/each}
        </dl>

        <ChartCard
          id="an-activity"
          title="Activity"
          description="Messages per {week ? 'week' : 'day'}, and the chats started"
          empty={data.kpis.messages === 0 ? 'No messages in this range.' : null}
        >
          <ColumnChart
            id="an-activity-chart"
            label="Messages and chats started per {week ? 'week' : 'day'}"
            {days}
            {week}
            series={messageSeries}
            line={chatsLine}
          />
          {#snippet table()}
            <DataTable
              caption="Messages and chats started per {week ? 'week' : 'day'}"
              columns={[week ? 'Week' : 'Day', 'Messages', 'Chats started']}
              rows={data.activity.map((a) => [dayName(a.day), a.messages, a.chatsStarted])}
            />
          {/snippet}
        </ChartCard>

        <ChartCard
          id="an-tokens"
          title="Output tokens by model"
          description="Tokens the models wrote per {week
            ? 'week'
            : 'day'}; the table also lists input and cache tokens"
          empty={data.kpis.outputTokens === 0 ? 'No token usage in this range.' : null}
        >
          <ColumnChart
            id="an-tokens-chart"
            label="Output tokens per {week ? 'week' : 'day'} by model"
            {days}
            {week}
            series={tokenSeries}
          />
          {#snippet table()}
            <DataTable
              caption="Tokens per model in the range"
              columns={['Model', 'Input', 'Output', 'Cache read', 'Cache write']}
              rows={data.tokens.totals.map((t) => [
                t.model,
                t.input,
                t.output,
                t.cacheRead,
                t.cacheCreation,
              ])}
            />
            <DataTable
              caption="Output tokens per {week ? 'week' : 'day'} and model"
              columns={[week ? 'Week' : 'Day', ...data.tokens.models]}
              rows={data.tokens.days.map((d) => [dayName(d.day), ...d.values])}
            />
          {/snippet}
        </ChartCard>

        <div class="grid gap-4 lg:grid-cols-2">
          <ChartCard
            id="an-projects"
            title="Top projects"
            description="By messages; choose one to see only that project"
            empty={data.projects.length === 0 ? 'No projects in this range.' : null}
          >
            <BarList
              label="Projects by messages"
              unit="messages"
              items={data.projects.map((p) => ({
                key: p.projectId,
                label: p.name,
                value: p.messages,
              }))}
              onSelect={filterTo}
              selected={analytics.projectId}
            />
            {#snippet table()}
              <DataTable
                caption="Top projects"
                columns={['Project', 'Messages', 'Chats']}
                rows={data.projects.map((p) => [p.name, p.messages, p.chats])}
              />
            {/snippet}
          </ChartCard>

          <ChartCard
            id="an-tools"
            title="Tools used"
            description="The 10 most called tools"
            empty={data.tools.length === 0 ? 'No tool calls in this range.' : null}
          >
            <BarList
              label="Tools by calls"
              unit="calls"
              items={data.tools.map((t) => ({ key: t.name, label: t.name, value: t.calls }))}
            />
            {#snippet table()}
              <DataTable
                caption="Tools used"
                columns={['Tool', 'Calls']}
                rows={data.tools.map((t) => [t.name, t.calls])}
              />
            {/snippet}
          </ChartCard>

          <ChartCard
            id="an-agents"
            title="Subagents"
            description="Agent calls by subagent type, top 10"
            empty={data.agents.length === 0 ? 'No subagents in this range.' : null}
          >
            <BarList
              label="Subagent types by calls"
              unit="calls"
              items={data.agents.map((a) => ({ key: a.type, label: a.type, value: a.calls }))}
            />
            {#snippet table()}
              <DataTable
                caption="Subagents"
                columns={['Subagent type', 'Calls']}
                rows={data.agents.map((a) => [a.type, a.calls])}
              />
            {/snippet}
          </ChartCard>

          <ChartCard
            id="an-topics"
            title="Topics"
            description="The most frequent words of the chat titles, by chats"
            empty={data.topics.length === 0 ? 'No titled chats in this range.' : null}
          >
            <BarList
              label="Title words by chats"
              unit="chats"
              color="var(--viz-s3)"
              items={data.topics.slice(0, 12).map((t) => ({
                key: t.word,
                label: t.word,
                value: t.chats,
              }))}
            />
            {#snippet table()}
              <DataTable
                caption="Topics"
                columns={['Word', 'Chats']}
                rows={data.topics.map((t) => [t.word, t.chats])}
              />
            {/snippet}
          </ChartCard>
        </div>

        <ChartCard
          id="an-hours"
          title="When you work"
          description="Messages per weekday and hour, in this computer's time zone"
          empty={data.kpis.messages === 0 ? 'No messages in this range.' : null}
        >
          <Heatmap label="Messages per weekday and hour" values={data.heatmap} />
          {#snippet table()}
            <DataTable
              caption="Messages per weekday and hour"
              columns={['Hour', ...WEEKDAYS_LONG]}
              rows={Array.from({ length: 24 }, (_, h) => [
                hourLabel(h),
                ...data.heatmap.map((row) => row[h] ?? 0),
              ])}
            />
          {/snippet}
        </ChartCard>
      </div>
    {/if}
  </div>
</section>

<style>
  /*
   * Chart colors (dataviz reference palette, validated with its checker
   * against this app's surfaces: light #ffffff, dark #0a0a0a). Categorical
   * slots in fixed order; the sequential ramp runs light→dark in light mode
   * and dark→bright in dark mode. Text always uses the app's text tokens.
   */
  .viz-root {
    --viz-s1: #2a78d6;
    --viz-s2: #eb6834;
    --viz-s3: #1baf7a;
    --viz-s4: #eda100;
    --viz-other: #a9a7a0;
    --viz-grid: #e8e7e1;
    --viz-axis: #c3c2b7;
    --viz-empty: #f0efec;
    --viz-seq-1: #cde2fb;
    --viz-seq-2: #9ec5f4;
    --viz-seq-3: #6da7ec;
    --viz-seq-4: #3987e5;
    --viz-seq-5: #256abf;
    --viz-seq-6: #184f95;
  }
  :global([data-theme='dark']) .viz-root {
    --viz-s1: #3987e5;
    --viz-s2: #d95926;
    --viz-s3: #199e70;
    --viz-s4: #c98500;
    --viz-other: #6b6a66;
    --viz-grid: #262624;
    --viz-axis: #383835;
    --viz-empty: #1d1d1c;
    --viz-seq-1: #0d366b;
    --viz-seq-2: #184f95;
    --viz-seq-3: #256abf;
    --viz-seq-4: #3987e5;
    --viz-seq-5: #6da7ec;
    --viz-seq-6: #b7d3f6;
  }
</style>
