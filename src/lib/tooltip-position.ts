/** Gap between a tooltip and its anchor, and the margin it keeps off the window edge. */
export const TOOLTIP_GAP = 6;
export const TOOLTIP_EDGE = 8;

/**
 * Above the anchor when there is room, below it otherwise, and never past a
 * window edge: a tip centred on its anchor loses half of itself on a short
 * bubble hard against either side of a narrow window.
 */
export function placeTooltip({
  anchor,
  size,
  viewportWidth,
}: {
  anchor: { top: number; bottom: number; left: number; width: number };
  size: { width: number; height: number };
  viewportWidth: number;
}) {
  const above = anchor.top - TOOLTIP_GAP - size.height;
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  return {
    top: above >= TOOLTIP_EDGE ? above : anchor.bottom + TOOLTIP_GAP,
    left: Math.max(TOOLTIP_EDGE, Math.min(centered, viewportWidth - size.width - TOOLTIP_EDGE)),
  };
}
