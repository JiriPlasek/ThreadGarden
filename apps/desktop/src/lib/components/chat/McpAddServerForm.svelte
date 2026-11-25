<script lang="ts">
  import type { McpScope, McpServerConfig } from '@threadgarden/protocol';
  import { Button } from '#lib/components/ui/button/index.js';
  import {
    emptyAddForm,
    PROJECT_SCOPE_NOTE,
    SCOPE_LABELS,
    toServerConfig,
    validateAddForm,
  } from './mcp';

  /**
   * "Add MCP server": name, type, address or command, headers or environment
   * (values masked), and who uses it. Claude Code's refusal is shown as it is
   * and the values stay, so the form can be fixed and sent again.
   */
  let {
    onAdd,
    onCancel,
  }: {
    onAdd: (name: string, scope: McpScope, config: McpServerConfig) => Promise<void>;
    onCancel: () => void;
  } = $props();

  let form = $state(emptyAddForm());
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const scopes = Object.keys(SCOPE_LABELS) as McpScope[];
  const rows = $derived(form.type === 'http' ? form.headers : form.env);
  const pairsTitle = $derived(form.type === 'http' ? 'Headers' : 'Environment');
  const pairsLabel = $derived(form.type === 'http' ? 'Header' : 'Environment');

  const submit = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    problem = validateAddForm(form);
    if (problem) return;
    busy = true;
    try {
      await onAdd(form.name.trim(), form.scope, toServerConfig(form));
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };

  const inputClass =
    'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2';
  const labelClass = 'text-muted-foreground text-xs font-medium';
  const optionClass =
    'hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm';
</script>

<form class="flex flex-col gap-3" onsubmit={submit}>
  <h3 class="text-base font-medium">Add MCP server</h3>
  <label class="flex flex-col gap-1">
    <span class={labelClass}>Name</span>
    <input
      type="text"
      class={inputClass}
      placeholder="sentry"
      autocomplete="off"
      spellcheck="false"
      bind:value={form.name}
    />
  </label>
  <fieldset class="flex flex-col gap-0.5">
    <legend class={`${labelClass} mb-1`}>Type</legend>
    <div class="flex gap-2">
      <label class={optionClass}>
        <input type="radio" name="mcp-add-type" value="http" bind:group={form.type} />
        <span>URL (http)</span>
      </label>
      <label class={optionClass}>
        <input type="radio" name="mcp-add-type" value="stdio" bind:group={form.type} />
        <span>Command (stdio)</span>
      </label>
    </div>
  </fieldset>
  {#if form.type === 'http'}
    <label class="flex flex-col gap-1">
      <span class={labelClass}>URL</span>
      <input
        type="text"
        class={inputClass}
        placeholder="https://mcp.sentry.dev/mcp"
        autocomplete="off"
        spellcheck="false"
        bind:value={form.url}
      />
    </label>
  {:else}
    <label class="flex flex-col gap-1">
      <span class={labelClass}>Command</span>
      <input
        type="text"
        class={inputClass}
        placeholder="npx"
        autocomplete="off"
        spellcheck="false"
        bind:value={form.command}
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class={labelClass}>Arguments (one per line)</span>
      <textarea
        rows="3"
        class="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 font-mono text-sm outline-none focus-visible:ring-2"
        spellcheck="false"
        bind:value={form.args}></textarea>
    </label>
  {/if}
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class={labelClass}>{pairsTitle}</span>
      <span class="text-muted-foreground text-xs">(values hidden)</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-xs"
        onclick={() => rows.push({ key: '', value: '' })}>+ add</Button
      >
    </div>
    {#each rows as pair, i (i)}
      <div class="flex gap-1">
        <input
          type="text"
          class={inputClass}
          aria-label={`${pairsLabel} name ${i + 1}`}
          autocomplete="off"
          spellcheck="false"
          bind:value={pair.key}
        />
        <input
          type="password"
          class={inputClass}
          aria-label={`${pairsLabel} value ${i + 1}`}
          autocomplete="off"
          bind:value={pair.value}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-8 px-2"
          aria-label={`Remove ${pairsLabel.toLowerCase()} ${i + 1}`}
          onclick={() => rows.splice(i, 1)}>×</Button
        >
      </div>
    {/each}
  </div>
  <fieldset class="flex flex-col gap-0.5">
    <legend class={`${labelClass} mb-1`}>Who uses it</legend>
    {#each scopes as scope (scope)}
      <label class={optionClass}>
        <input type="radio" name="mcp-add-scope" value={scope} bind:group={form.scope} />
        <span>{SCOPE_LABELS[scope]}</span>
      </label>
    {/each}
    {#if form.scope === 'project'}
      <p class="text-muted-foreground px-2 text-xs">{PROJECT_SCOPE_NOTE}</p>
    {/if}
  </fieldset>
  <div class="flex justify-end gap-2">
    <Button type="button" variant="outline" size="sm" disabled={busy} onclick={onCancel}
      >Cancel</Button
    >
    <Button type="submit" size="sm" disabled={busy}>Add</Button>
  </div>
  {#if problem}
    <p class="text-destructive text-sm break-words" role="alert">{problem}</p>
  {/if}
</form>
