import { SIDEBAR_INLINE_BREAKPOINT } from "./sidebar-preferences";

export const SWIPE_SLOP = 10;
export const SWIPE_EDGE = 24;
export const SWIPE_DISTANCE = 0.3;
export const SWIPE_VELOCITY = 0.4;
export const SWIPE_MOTION_MS = 260;
// critically damped spring: fast start, no overshoot
export const SWIPE_SPRING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const VIBRATION_KEY = "omb-vibration";

export type SwipeAxis = "x" | "y" | null;
export type SwipeStep = -1 | 0 | 1;

export function isPhone(win: typeof window = window): boolean {
  return win.matchMedia?.(`(max-width: ${SIDEBAR_INLINE_BREAKPOINT - 0.02}px)`).matches ?? false;
}

export function reducedMotion(win: typeof window = window): boolean {
  return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Ties go to y so a diagonal start keeps scrolling. */
export function lockAxis(dx: number, dy: number): SwipeAxis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Left swipe goes to the next bot, right swipe to the previous one. `velocity` is px/ms at release. */
export function swipeStep(dx: number, velocity: number, width: number): SwipeStep {
  const fast = Math.abs(velocity) >= SWIPE_VELOCITY;
  if (fast && Math.sign(velocity) !== Math.sign(dx)) return 0;
  if (!(fast && Math.abs(dx) >= SWIPE_SLOP * 2) && Math.abs(dx) < width * SWIPE_DISTANCE) return 0;
  return dx < 0 ? 1 : -1;
}

/** Stops at both ends, no wrap. */
export function neighborId(ids: readonly string[], currentId: string, step: SwipeStep): string | null {
  const index = ids.indexOf(currentId);
  if (index < 0 || step === 0) return null;
  return ids[index + step] ?? null;
}

/** Rubber band past the first or last bot. */
export function dragOffset(dx: number, canMove: boolean): number {
  return canMove ? dx : dx / 3;
}

export function sidebarBotIds(doc: Document = document): string[] {
  return [...doc.querySelectorAll('[data-sidebar-row-kind="bot"]')].flatMap((row) => row.getAttribute("data-sidebar-row-id") ?? []);
}

export function swipeBlocked(target: EventTarget | null, startX: number, win: typeof window = window): boolean {
  if (startX < SWIPE_EDGE || startX > win.innerWidth - SWIPE_EDGE) return true;
  const selection = win.getSelection?.();
  if (selection && !selection.isCollapsed) return true;
  if (!(target instanceof win.Element)) return true;
  if (target.closest('textarea, input, select, [contenteditable="true"], [data-orbit-composer-frame], pre, table, [data-no-swipe]')) return true;
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    const overflow = win.getComputedStyle(node).overflowX;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

// This session's choice wins; storage may not hold it (e.g. private browsing).
let sessionVibration: boolean | null = null;

export function vibrationEnabled(storage?: Pick<Storage, "getItem"> | null): boolean {
  if (sessionVibration !== null) return sessionVibration;
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return target?.getItem(VIBRATION_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveVibration(on: boolean, storage?: Pick<Storage, "setItem"> | null): void {
  sessionVibration = on;
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(VIBRATION_KEY, on ? "on" : "off");
  } catch {
    // Private browsing may reject localStorage; the toggle still works this session.
  }
}

export function hapticTick(win: typeof window = window, storage?: Pick<Storage, "getItem"> | null): void {
  if (!isPhone(win) || reducedMotion(win) || !vibrationEnabled(storage)) return;
  try {
    win.navigator.vibrate?.(10);
  } catch {
    /* ignore */
  }
}
