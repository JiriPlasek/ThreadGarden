<script lang="ts">
  import type { TimelineActivity } from '@threadgarden/protocol';
  import { ACTIVITY_COLORS, activityRuns } from './timeline-activity';

  let {
    activity,
    top,
    height,
    yOf,
  }: {
    activity: TimelineActivity;
    top: number;
    height: number;
    yOf: (at: number) => number;
  } = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    const element = canvas;
    const data = activity;
    const blockTop = top;
    const blockHeight = height;
    const mapY = yOf;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context || blockHeight <= 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    element.width = Math.round(8 * ratio);
    element.height = Math.min(4096, Math.max(1, Math.ceil(blockHeight * ratio)));
    context.fillStyle = 'rgba(148,163,184,0.22)';
    context.fillRect(0, 0, element.width, element.height);
    const rasterY = (at: number): number =>
      Math.min(
        element.height - 1,
        Math.max(0, ((mapY(at) - blockTop) / blockHeight) * element.height),
      );
    for (const run of activityRuns(data)) {
      const first = Math.floor(rasterY(run.from));
      const last = Math.min(
        element.height,
        Math.max(first + 1, Math.ceil(((mapY(run.to) - blockTop) / blockHeight) * element.height)),
      );
      for (let channel = 0; channel < 4; channel++) {
        if (!(run.mask & (1 << channel))) continue;
        context.fillStyle = ACTIVITY_COLORS[channel]!;
        context.fillRect(channel * 2 * ratio, first, 2 * ratio, last - first);
      }
    }
  });
</script>

<canvas
  bind:this={canvas}
  aria-hidden="true"
  class="pointer-events-none absolute inset-y-0 left-0 h-full w-2"
></canvas>
