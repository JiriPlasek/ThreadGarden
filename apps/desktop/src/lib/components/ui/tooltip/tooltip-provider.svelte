<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import { isPhone } from '#lib/native.js';

  let { delayDuration = 0, disabled, ...restProps }: TooltipPrimitive.ProviderProps = $props();
</script>

<!-- No tooltips on the phone: a tap would leave one standing. -->
<TooltipPrimitive.Provider {delayDuration} disabled={isPhone || disabled} {...restProps} />
