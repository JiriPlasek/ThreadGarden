<script lang="ts">
  /** The "Create in" folder of a new project: typed, or picked with the folder browser. */
  let {
    value,
    onChange,
    browse,
  }: { value: string; onChange: (v: string) => void; browse: () => void } = $props();
</script>

<div class="grid gap-1">
  <label for="create-in" class="text-muted-foreground text-xs">Create in</label>
  <div class="flex gap-2">
    <input
      id="create-in"
      class="bg-background h-8 w-full min-w-0 rounded-md border px-2 font-mono text-sm"
      spellcheck="false"
      autocomplete="off"
      {value}
      oninput={(e) => onChange(e.currentTarget.value)}
    />
    <button
      type="button"
      class="hover:bg-muted h-8 shrink-0 rounded-md border px-3 text-sm"
      onclick={browse}>Browse…</button
    >
  </div>
</div>
