<script lang="ts">
  import './layout.css';
  import { settings } from '#lib/state/settings.svelte.js';
  import { applyTheme } from '#lib/theme.js';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  // Theme setting (system follows the OS preference live), as `data-theme` on <html>.
  $effect(() => applyTheme(settings.value.theme));
</script>

{@render children()}
