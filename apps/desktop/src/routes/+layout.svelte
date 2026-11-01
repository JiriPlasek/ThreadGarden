<script lang="ts">
  import './layout.css';
  import { settings } from '#lib/state/settings.svelte.js';
  import { applyAppearance } from '#lib/appearance.js';
  import { applyTheme } from '#lib/theme.js';
  import ErrorBoundary from '#lib/components/ErrorBoundary.svelte';
  import { installErrorReporting } from '#lib/ui-errors.js';
  import { reportUiError } from '#lib/ui-error-reporter.js';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  // Theme setting (system follows the OS preference live), as `data-theme` on <html>.
  $effect(() => applyTheme(settings.value.theme));
  // Accent, light/dark style and fonts (spec v1.3 §6), as attributes next to it; live.
  $effect(() => applyAppearance(settings.value));
  // Errors nothing else handled go to the service log (the webview keeps none).
  $effect(() => installErrorReporting(window, reportUiError));
</script>

<ErrorBoundary report={reportUiError}>
  {@render children()}
</ErrorBoundary>
