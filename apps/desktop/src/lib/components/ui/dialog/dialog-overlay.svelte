<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import { cn } from '#lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: DialogPrimitive.OverlayProps = $props();
  // No backdrop blur (shadcn's default): re-blurring the window behind every
  // frame pushed typing in the quick switcher past its 50 ms budget (spec §8)
  // in software-rendered webviews.
</script>

<DialogPrimitive.Overlay
  bind:ref
  data-slot="dialog-overlay"
  class={cn(
    'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/20 duration-100 fixed inset-0 isolate z-50',
    className,
  )}
  {...restProps}
/>
