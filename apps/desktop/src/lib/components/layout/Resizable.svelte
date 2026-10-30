<script lang="ts">
  /**
   * Vertical drag handle between two columns. Dragging (pointer capture) or the
   * arrow keys change `width` within [min, max]; double-click restores `initial`.
   * `onChange` sees every new width (the caller debounces persistence).
   */
  let {
    width,
    min,
    max,
    initial,
    label,
    onChange,
  }: {
    width: number;
    min: number;
    max: number;
    initial: number;
    label: string;
    onChange: (width: number) => void;
  } = $props();

  const KEY_STEP = 16;
  let drag: { x: number; width: number } | null = $state(null);

  const clamp = (w: number): number => Math.min(max, Math.max(min, w));
  const set = (w: number): void => {
    const next = clamp(Math.round(w));
    if (next !== width) onChange(next);
  };

  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { x: e.clientX, width };
  };
  const move = (e: PointerEvent): void => {
    if (drag) set(drag.width + e.clientX - drag.x);
  };
  const up = (e: PointerEvent): void => {
    if (!drag) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag = null;
  };
  const key = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    if (e.key === 'ArrowLeft') set(width - step);
    else if (e.key === 'ArrowRight') set(width + step);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else return;
    e.preventDefault();
  };
</script>

<!-- A focusable separator is the WAI-ARIA window-splitter pattern. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={width}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  class="group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize touch-none outline-none select-none"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={() => set(initial)}
  onkeydown={key}
>
  <div
    class="bg-border group-hover:bg-ring group-focus-visible:bg-ring mx-auto h-full w-px transition-colors {drag
      ? 'bg-ring'
      : ''}"
  ></div>
</div>
