type AnchorRect = { left: number; top: number; bottom: number };

/** Viewport coordinates, independent of transformed or scrolling ancestors. */
export const previewPosition = (
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } => {
  const margin = 8;
  const gap = 6;
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  const fitsAbove = above >= margin;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const preferred =
    fitsAbove || (!fitsBelow && anchor.top > viewport.height - anchor.bottom) ? above : below;
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(preferred, viewport.height - size.height - margin)),
  };
};
