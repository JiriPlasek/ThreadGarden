<script lang="ts" generics="T = never">
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import { isPhone } from '#lib/native.js';

  let { open = $bindable(false), disabled, ...restProps }: TooltipPrimitive.RootProps<T> = $props();
</script>

<!-- No tooltips on the phone: a tap would leave one standing. -->
<TooltipPrimitive.Root bind:open disabled={isPhone || disabled} {...restProps} />
