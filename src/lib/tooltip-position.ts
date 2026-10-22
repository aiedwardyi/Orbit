/** Gap between a tooltip and its anchor, and the margin it keeps off the window edge. */
export const TOOLTIP_GAP = 6;
export const TOOLTIP_EDGE = 8;
/** Anchors wider than this centre the tip on the pointer instead of the element. */
export const TOOLTIP_WIDE_PX = 160;

/** Centre of a narrow anchor, or the pointer's x clamped onto a wide one. */
export function anchorForTip(
  rect: { top: number; bottom: number; left: number; width: number },
  pointerX: number,
) {
  if (rect.width <= TOOLTIP_WIDE_PX) return rect;
  return { top: rect.top, bottom: rect.bottom, left: Math.max(rect.left, Math.min(pointerX, rect.left + rect.width)), width: 0 };
}

/** Bottom of the Windows caption strip, which paints over any tip under it. */
export function captionInset() {
  if (typeof document === "undefined") return 0;
  return document.querySelector(".orbit-windows-caption")?.getBoundingClientRect().bottom ?? 0;
}

/**
 * Above the anchor when there is room, below it otherwise, and never past a
 * window edge on either axis: a tip centred on its anchor loses half of itself
 * on a short bubble hard against the side of a narrow window, and a short
 * window can leave no room under the anchor either.
 */
export function placeTooltip({
  anchor,
  size,
  viewportWidth,
  viewportHeight,
  topInset = captionInset(),
}: {
  anchor: { top: number; bottom: number; left: number; width: number };
  size: { width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
  topInset?: number;
}) {
  const above = anchor.top - TOOLTIP_GAP - size.height;
  const fit = (value: number, span: number, extent: number, start = 0) =>
    Math.max(start + TOOLTIP_EDGE, Math.min(value, extent - span - TOOLTIP_EDGE));
  return {
    top: fit(above >= topInset + TOOLTIP_EDGE ? above : anchor.bottom + TOOLTIP_GAP, size.height, viewportHeight, topInset),
    left: fit(anchor.left + anchor.width / 2 - size.width / 2, size.width, viewportWidth),
  };
}
