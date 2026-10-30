<script lang="ts">
  import './layout.css';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  // Follow the OS light/dark preference (the theme setting arrives with the settings UI).
  $effect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  });
</script>

{@render children()}
