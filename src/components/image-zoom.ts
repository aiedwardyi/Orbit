export const KEY_STEP = 1.25;
export const WHEEL_SENSITIVITY = 0.0025;

export interface ZoomFrame {
  viewW: number;
  viewH: number;
  sourceW: number;
  sourceH: number;
  fit: number;
}

export interface ZoomView {
  scale: number;
  panX: number;
  panY: number;
}

export function imageFrame(viewW: number, viewH: number, sourceW: number, sourceH: number): ZoomFrame {
  return { viewW, viewH, sourceW, sourceH, fit: Math.min(1, viewW / sourceW, viewH / sourceH) };
}

export function fitView(frame: ZoomFrame): ZoomView {
  return { scale: frame.fit, panX: 0, panY: 0 };
}

export function atFit(view: ZoomView, frame: ZoomFrame): boolean {
  return Math.abs(view.scale - frame.fit) < 0.000001;
}

export function clampScale(scale: number, fit: number): number {
  if (!Number.isFinite(scale)) return fit;
  if (Math.abs(scale - 1) < 1e-12) return 1;
  return Math.min(Math.max(8, fit * 8), Math.max(fit, scale));
}

export function clampPan(panX: number, panY: number, sw: number, sh: number, viewW: number, viewH: number) {
  const limitX = Math.max(0, (sw - viewW) / 2);
  const limitY = Math.max(0, (sh - viewH) / 2);
  return {
    x: Math.min(limitX, Math.max(-limitX, Number.isFinite(panX) ? panX : 0)) || 0,
    y: Math.min(limitY, Math.max(-limitY, Number.isFinite(panY) ? panY : 0)) || 0,
  };
}

export function zoomAround(
  view: ZoomView,
  point: { x: number; y: number },
  frame: ZoomFrame,
  factor: number,
  move = { x: 0, y: 0 },
): ZoomView {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return view;
  const scale = clampScale(view.scale * factor, frame.fit);
  const ratio = scale / view.scale;
  const pan = clampPan(
    (point.x - frame.viewW / 2) * (1 - ratio) + view.panX * ratio + move.x,
    (point.y - frame.viewH / 2) * (1 - ratio) + view.panY * ratio + move.y,
    frame.sourceW * scale, frame.sourceH * scale, frame.viewW, frame.viewH,
  );
  return { scale, panX: pan.x, panY: pan.y };
}

export function panBy(view: ZoomView, dx: number, dy: number, frame: ZoomFrame): ZoomView {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return view;
  const pan = clampPan(view.panX + dx, view.panY + dy, frame.sourceW * view.scale, frame.sourceH * view.scale, frame.viewW, frame.viewH);
  return { ...view, panX: pan.x, panY: pan.y };
}

export function toggleZoomAt(view: ZoomView, point: { x: number; y: number }, frame: ZoomFrame): ZoomView {
  return atFit(view, frame) ? zoomAround(view, point, frame, (frame.fit === 1 ? 2 : 1) / view.scale) : fitView(frame);
}

export function resizeView(view: ZoomView, before: ZoomFrame, after: ZoomFrame): ZoomView {
  if (atFit(view, before)) return fitView(after);
  const scale = clampScale(view.scale, after.fit);
  return panBy({ scale, panX: view.panX * scale / view.scale, panY: view.panY * scale / view.scale }, 0, 0, after);
}

export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(Math.max(-20, Math.min(20, -deltaY * WHEEL_SENSITIVITY)));
}

export type ZoomKeyAction = "in" | "out" | "reset";

export function zoomKeyAction(event: { altKey: boolean; key: string }): ZoomKeyAction | null {
  if (event.altKey) return null;
  if (event.key === "=" || event.key === "+" || event.key === "Add") return "in";
  if (event.key === "-" || event.key === "_" || event.key === "Subtract") return "out";
  if (event.key === "0" || event.key === "Numpad0") return "reset";
  return null;
}
