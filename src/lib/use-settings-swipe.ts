import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { lockAxis, reducedMotion, SWIPE_MOTION_MS, SWIPE_SLOP, SWIPE_SPRING, SWIPE_VELOCITY, swipeBlocked, type SwipeAxis } from "./phone-swipe";

type Drag = { x: number; y: number; lastX: number; lastT: number; velocity: number; axis: SwipeAxis; width: number; reduced: boolean };

export function useSettingsSwipe(ref: RefObject<HTMLElement | null>, enabled: boolean, page: string | false, back: () => void): void {
  const latest = useRef(back);
  useLayoutEffect(() => { latest.current = back; });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !enabled) return;
    const list = dialog.querySelector<HTMLElement>("[data-settings-underlay]");
    const stage = page ? dialog.querySelector<HTMLElement>("[data-settings-page]") : dialog;
    const scrim = page ? null : dialog.parentElement?.querySelector<HTMLElement>("[data-settings-scrim]");
    if (!stage) return;
    let drag: Drag | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settling = false;
    let completed = false;
    const clear = () => {
      for (const node of [stage, page ? list : null, scrim]) {
        for (const key of ["transform", "opacity", "transition", "will-change"]) node?.style.removeProperty(key);
      }
    };
    const paint = (x: number, width: number) => {
      const progress = Math.min(1, x / width);
      stage.style.transform = `translate3d(${x}px, 0, 0)`;
      if (page && list) {
        list.style.transform = `translate3d(${(progress - 1) * width * 0.25}px, 0, 0)`;
        list.style.opacity = String(0.8 + progress * 0.2);
      }
      if (scrim) scrim.style.opacity = String(1 - progress);
    };
    clear();
    const start = (event: TouchEvent) => {
      if (drag?.axis === "x") {
        if (event.touches.length !== 1) finish(false, event);
        return;
      }
      drag = null;
      const touch = event.touches[0];
      if (settling || event.touches.length !== 1 || !touch || !(event.target instanceof Element)) return;
      if (event.target.closest('[role="slider"], .dial-stage')) return;
      // Settings accepts starts at either edge, unlike chat navigation.
      if (swipeBlocked(event.target, window.innerWidth / 2)) return;
      drag = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, axis: null, width: stage.clientWidth || window.innerWidth, reduced: reducedMotion() };
    };
    const move = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) { finish(false, event); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - drag.x;
      if (!drag.axis) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) { drag = null; return; }
        drag.axis = lockAxis(dx, touch.clientY - drag.y);
        if (drag.axis === "y" || (drag.axis === "x" && dx < 0)) { drag = null; return; }
        if (!drag.axis) return;
        if (!drag.reduced) {
          stage.style.willChange = "transform";
          if (page && list) list.style.willChange = "transform, opacity";
        }
      }
      if (event.cancelable) event.preventDefault();
      const dt = event.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = event.timeStamp;
      if (!drag.reduced) paint(Math.max(0, dx), drag.width);
    };
    const finish = (commit: boolean, event: TouchEvent) => {
      const done = drag;
      drag = null;
      if (done?.axis !== "x") return;
      // Suppress the click a touch drag can otherwise leave behind.
      if (event.cancelable && event.type !== "touchstart") event.preventDefault();
      const dx = done.lastX - done.x;
      const velocity = event.timeStamp - done.lastT > 100 ? 0 : done.velocity;
      const closes = commit && dx >= SWIPE_SLOP * 2 && (dx >= done.width * 0.35 || velocity >= SWIPE_VELOCITY) && velocity > -SWIPE_VELOCITY;
      if (done.reduced) {
        if (closes) latest.current();
        return;
      }
      settling = true;
      const motion = `${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
      for (const node of [stage, page ? list : null, scrim]) {
        if (node) node.style.transition = `transform ${motion}, opacity ${motion}`;
      }
      paint(closes ? window.innerWidth : 0, done.width);
      timer = setTimeout(() => {
        settling = false;
        completed = closes;
        if (closes) latest.current();
        else clear();
      }, SWIPE_MOTION_MS);
    };
    const end = (event: TouchEvent) => finish(true, event);
    const cancel = (event: TouchEvent) => finish(false, event);
    dialog.addEventListener("touchstart", start, { passive: true });
    dialog.addEventListener("touchmove", move, { passive: false });
    dialog.addEventListener("touchend", end, { passive: false });
    dialog.addEventListener("touchcancel", cancel, { passive: false });
    return () => {
      clearTimeout(timer);
      dialog.removeEventListener("touchstart", start);
      dialog.removeEventListener("touchmove", move);
      dialog.removeEventListener("touchend", end);
      dialog.removeEventListener("touchcancel", cancel);
      if (!completed || page) clear();
    };
  }, [ref, enabled, page]);
}
