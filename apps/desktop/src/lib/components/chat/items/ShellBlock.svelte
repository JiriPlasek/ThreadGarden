<script lang="ts">
  import type { ShellRun } from '@threadgarden/protocol';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal, type ITheme } from '@xterm/xterm';
  import '@xterm/xterm/css/xterm.css';
  import { onMount, untrack } from 'svelte';
  import type { ShellOutput } from '#lib/state/shell-output.js';
  import {
    SHELL_BLOCK_ROWS,
    SHELL_SCROLLBACK_LINES,
    shellFooter,
    shellTitle,
  } from '../shell-format';

  /**
   * A `!` command's live terminal in the chat: title, Stop, an xterm terminal
   * (keystrokes go to the running command; nothing once it ended) and a footer.
   * It draws at the run's width and scrolls sideways when the pane is narrower.
   * Only the window the user is typing in (the starter, or one with focus)
   * resizes the run, so another window never changes a run it isn't using.
   */
  let {
    run,
    output,
    machineName,
    home,
    autofocus = false,
    onInput,
    onResize,
    onStop,
  }: {
    run: ShellRun;
    output: ShellOutput;
    machineName: string;
    home: string;
    autofocus?: boolean;
    onInput: (data: string) => void;
    onResize: (size: { cols: number; rows: number }) => void;
    onStop: () => void;
  } = $props();

  const FALLBACK_FONT =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

  let host = $state<HTMLDivElement | null>(null);
  let term = $state.raw<Terminal | null>(null);
  let fit: FitAddon | null = null;
  let stopAsked = $state(false);
  let focused = false;
  let lastSent = '';
  let now = $state(Date.now());

  const running = $derived(run.state === 'running');
  const ended = $derived(run.state === 'ended');
  const title = $derived(shellTitle(run, machineName, home));
  const footer = $derived(shellFooter(run, now));
  const rowsShown = (r: ShellRun): number => Math.min(r.rows, SHELL_BLOCK_ROWS);

  /** The app's mono font and colours as they are now (they change with the theme). */
  const look = (): { fontFamily: string; theme: ITheme } => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string): string | undefined => css.getPropertyValue(name).trim() || undefined;
    return {
      fontFamily: v('--font-mono') ?? FALLBACK_FONT,
      theme: {
        background: v('--background'),
        foreground: v('--foreground'),
        cursor: v('--foreground'),
        cursorAccent: v('--background'),
        selectionBackground: v('--accent'),
        selectionForeground: v('--accent-foreground'),
      },
    };
  };

  /** Tells the service how big the terminal is here (same size twice is skipped). */
  const sendSize = (): void => {
    const dims = fit?.proposeDimensions();
    if (!term || !dims || !(dims.cols >= 2)) return;
    const size = { cols: dims.cols, rows: term.rows };
    const key = `${size.cols}x${size.rows}`;
    if (key === lastSent) return;
    lastSent = key;
    onResize(size);
  };

  onMount(() => {
    if (!host) return;
    const t = new Terminal({
      cols: run.cols,
      rows: rowsShown(run),
      scrollback: SHELL_SCROLLBACK_LINES,
      disableStdin: run.state !== 'running',
      convertEol: false,
      ...look(),
    });
    fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host);
    t.onData((data) => {
      if (untrack(() => run.state) === 'running') onInput(data);
    });
    term = t;
    if (autofocus) {
      focused = true;
      sendSize();
      t.focus();
    }

    const watchLook = new MutationObserver(() => {
      const l = look();
      t.options.fontFamily = l.fontFamily;
      t.options.theme = l.theme;
    });
    watchLook.observe(document.documentElement, { attributes: true });
    const watchWidth =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (focused) sendSize();
          })
        : null;
    watchWidth?.observe(host);
    const tick = setInterval(() => (now = Date.now()), 1000);

    return () => {
      clearInterval(tick);
      watchWidth?.disconnect();
      watchLook.disconnect();
      term = null;
      t.dispose();
    };
  });

  // The scrollback, then each new chunk; a reset (or another run's output) redraws.
  let drawnOn: Terminal | null = null;
  $effect(() => {
    const t = term;
    const out = output;
    if (!t) return;
    if (drawnOn === t) t.reset();
    drawnOn = t;
    const text = out.text();
    if (text) t.write(text);
    return out.listen((data, reset) => {
      if (reset) t.reset();
      t.write(data);
    });
  });

  $effect(() => {
    if (term) term.options.disableStdin = !running;
  });

  // Another window (or the service) resized the run: draw at its width.
  $effect(() => {
    const t = term;
    const cols = run.cols;
    const rows = rowsShown(run);
    if (t && (t.cols !== cols || t.rows !== rows)) t.resize(cols, rows);
  });

  $effect(() => {
    if (ended) stopAsked = false;
  });

  const stop = (): void => {
    stopAsked = true;
    onStop();
  };
  const onfocusin = (): void => {
    focused = true;
    sendSize();
  };
  const onfocusout = (): void => {
    focused = false;
    lastSent = '';
  };
</script>

<div
  class="bg-background my-1 overflow-hidden rounded-md border text-xs"
  role="group"
  aria-label="Command output"
  data-shell-block
>
  <div class="bg-muted/50 flex items-center gap-2 border-b px-2 py-1">
    <span class="min-w-0 flex-1 truncate font-mono" {title}>{title}</span>
    {#if !ended}
      <button
        type="button"
        class="hover:bg-muted rounded border px-2 py-0.5 disabled:opacity-60"
        disabled={stopAsked || run.state === 'stopping'}
        onclick={stop}>{stopAsked || run.state === 'stopping' ? 'Stopping…' : 'Stop'}</button
      >
    {/if}
  </div>
  <div bind:this={host} {onfocusin} {onfocusout} data-terminal class="overflow-x-auto p-1"></div>
  <div class="text-muted-foreground border-t px-2 py-1 tabular-nums">{footer}</div>
</div>
