<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setContext, untrack } from 'svelte';
  import { SCOPE_CONTEXT } from '#lib/state/context.js';
  import type { MachineScope } from '#lib/state/scope.js';

  /**
   * Shows its content inside `scope`: the components there read that
   * machine's stores through `useScope()`. The scope is read once; key the
   * parent block on the machine to switch.
   */
  let { scope, children }: { scope: MachineScope; children: Snippet } = $props();

  setContext(
    SCOPE_CONTEXT,
    untrack(() => scope),
  );
</script>

{@render children()}
