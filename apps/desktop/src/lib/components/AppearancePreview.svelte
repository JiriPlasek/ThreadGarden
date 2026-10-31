<script lang="ts">
  import type { Settings } from '@threadgarden/protocol';
  import { DEFAULT_MONO_STACK, appearanceAttributes, codeFontStack } from '#lib/appearance.js';

  /**
   * A small live preview of the appearance settings being edited (spec v1.3
   * §6), in the light and the dark theme side by side: the stylesheet keys
   * its tokens on attributes, so each panel carries its own and shows the
   * unsaved choice inside the current app look.
   */
  let {
    appearance,
  }: {
    appearance: Pick<Settings, 'accent' | 'darkStyle' | 'lightStyle' | 'uiFont' | 'codeFont'>;
  } = $props();

  const attrs = $derived(appearanceAttributes(appearance));
  // Always set, so the panel shows its own code font, not the one the app has now.
  const mono = $derived(codeFontStack(appearance.codeFont) ?? DEFAULT_MONO_STACK);
</script>

<div class="grid grid-cols-2 gap-2" aria-label="Appearance preview" role="group">
  {#each ['light', 'dark'] as const as theme (theme)}
    <div
      data-theme={theme}
      {...attrs}
      style:--font-mono={mono}
      style:color-scheme={theme}
      class="bg-background text-foreground grid gap-2 rounded-md border p-2 font-sans text-xs"
      data-testid="appearance-preview-{theme}"
    >
      <div class="text-muted-foreground text-[11px] font-medium capitalize">{theme}</div>
      <div class="bg-muted/70 rounded-lg px-2 py-1.5">Can you add a test for this?</div>
      <pre
        class="bg-muted/50 m-0 overflow-hidden rounded-md border px-2 py-1 font-mono text-[11px]"><code
          >const ok = test();</code
        ></pre>
      <div class="bg-accent text-accent-foreground grid gap-0.5 rounded-md px-2 py-1">
        <span class="truncate font-medium">Selected chat</span>
        <span class="text-muted-foreground truncate">2 min ago · my-project</span>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="bg-primary text-primary-foreground ring-ring/50 inline-flex h-6 items-center rounded-md px-2 font-medium ring-2"
          >Send</span
        >
        <span class="text-muted-foreground">Focus ring</span>
      </div>
    </div>
  {/each}
</div>
