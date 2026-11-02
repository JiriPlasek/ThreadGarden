/**
 * jsdom lacks a few browser APIs that Svelte bindings and bits-ui rely on;
 * component tests get inert stand-ins. Rendered components are unmounted after each test,
 * and `localStorage` is cleared (a paired machine's kept usage must not leak into the next test).
 */
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.assign(window, { ResizeObserver: ResizeObserverStub });
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
}
