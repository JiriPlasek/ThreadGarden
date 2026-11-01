<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '#lib/components/ui/button/index.js';
</script>

<!-- Shown instead of SvelteKit's bare "500 Internal Error"; the error itself was
     already logged by `handleError` (hooks.client.ts). -->
<div role="alert" class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
  <h1 class="text-base font-semibold">Something went wrong</h1>
  <p class="text-muted-foreground max-w-prose text-sm break-words">
    {page.error?.message ?? 'An unexpected error.'}
  </p>
  <p class="text-muted-foreground max-w-prose text-xs">
    The details are in Threadgarden's log. Your chats are not affected.
  </p>
  <Button size="sm" onclick={() => location.reload()}>Reload</Button>
</div>
