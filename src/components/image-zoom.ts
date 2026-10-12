export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const CLICK_SCALE = 2;
export const KEY_STEP = 1.25;
export const WHEEL_SENSITIVITY = 0.0025;
const KEEP_PX = 48;

export interface ZoomFrame {
  viewW: number;
  viewH: number;
  fitW: number;
  fitH: number;
}

export interface ZoomView {
  scale: number;
  panX: number;
  panY: number;
}

export const FIT_VIEW: ZoomView = { scale: MIN_SCALE, panX: 0, panY: 0 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= MIN_SCALE) return MIN_SCALE;
  if (scale >= MAX_SCALE) return MAX_SCALE;
  return scale;
}

export function clampPan(
  panX: number,
  panY: number,
  sw: number,
  sh: number,
  viewW: number,
  viewH: number,
) {
  const keepX = Math.min(KEEP_PX, viewW / 2, Math.max(sw, 0));
  const keepY = Math.min(KEEP_PX, viewH / 2, Math.max(sh, 0));
  return {
    x: Math.min(viewW / 2 - keepX + sw / 2, Math.max(keepX - viewW / 2 - sw / 2, panX)),
    y: Math.min(viewH / 2 - keepY + sh / 2, Math.max(keepY - viewH / 2 - sh / 2, panY)),
  };
}

export function zoomAround(
  view: ZoomView,
  point: { x: number; y: number },
  frame: ZoomFrame,
  factor: number,
): ZoomView {
  if (!(frame.viewW > 0) || !(frame.viewH > 0) || !(frame.fitW > 0) || !(frame.fitH > 0)) return view;
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const next = clampScale(view.scale * factor);
  if (next === view.scale) return view;
  if (next === MIN_SCALE) return FIT_VIEW;
  const lx = (point.x - (frame.viewW / 2 + view.panX)) / view.scale;
  const ly = (point.y - (frame.viewH / 2 + view.panY)) / view.scale;
  const panX = point.x - frame.viewW / 2 - lx * next;
  const panY = point.y - frame.viewH / 2 - ly * next;
  const clamped = clampPan(panX, panY, frame.fitW * next, frame.fitH * next, frame.viewW, frame.viewH);
  return { scale: next, panX: clamped.x, panY: clamped.y };
}

export function panBy(view: ZoomView, dx: number, dy: number, frame: ZoomFrame): ZoomView {
  if (view.scale <= MIN_SCALE) return view;
  const clamped = clampPan(
    view.panX + dx,
    view.panY + dy,
    frame.fitW * view.scale,
    frame.fitH * view.scale,
    frame.viewW,
    frame.viewH,
  );
  return { scale: view.scale, panX: clamped.x, panY: clamped.y };
}

export function toggleZoomAt(
  view: ZoomView,
  point: { x: number; y: number },
  frame: ZoomFrame,
): ZoomView {
  if (view.scale <= MIN_SCALE) return zoomAround(view, point, frame, CLICK_SCALE);
  return FIT_VIEW;
}

export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return Math.exp(-deltaY * WHEEL_SENSITIVITY);
}

export function wheelPanOffset(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  frame: Pick<ZoomFrame, "viewW" | "viewH">,
) {
  if (event.deltaMode === 1) return { dx: -event.deltaX * 16, dy: -event.deltaY * 16 };
  if (event.deltaMode === 2) return { dx: -event.deltaX * frame.viewW, dy: -event.deltaY * frame.viewH };
  return { dx: -event.deltaX, dy: -event.deltaY };
}

export type ZoomKeyAction = "in" | "out" | "reset";

export function zoomKeyAction(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; key: string }): ZoomKeyAction | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;
  if (event.key === "=" || event.key === "+" || event.key === "Add") return "in";
  if (event.key === "-" || event.key === "_" || event.key === "Subtract") return "out";
  if (event.key === "0" || event.key === "Numpad0") return "reset";
  return null;
}
