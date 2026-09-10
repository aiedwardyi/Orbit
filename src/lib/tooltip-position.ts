/** Gap between a tooltip and its anchor, and the margin it keeps off the window edge. */
export const TOOLTIP_GAP = 6;
export const TOOLTIP_EDGE = 8;

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
}: {
  anchor: { top: number; bottom: number; left: number; width: number };
  size: { width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
}) {
  const above = anchor.top - TOOLTIP_GAP - size.height;
  const fit = (value: number, span: number, extent: number) =>
    Math.max(TOOLTIP_EDGE, Math.min(value, extent - span - TOOLTIP_EDGE));
  return {
    top: fit(above >= TOOLTIP_EDGE ? above : anchor.bottom + TOOLTIP_GAP, size.height, viewportHeight),
    left: fit(anchor.left + anchor.width / 2 - size.width / 2, size.width, viewportWidth),
  };
}
