import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { hapticTick } from "./phone-swipe";

export const LONG_PRESS_MS = 400;
export const LONG_PRESS_SLOP = 8;
const SCROLL_EDGE = 48;
const SCROLL_STEP = 10;
const LIFTED_STYLE: Record<string, string> = {
  position: "relative",
  // under the z-10 drop marker, so the target edge stays visible beneath the finger
  "z-index": "5",
  scale: "1.03",
  background: "var(--color-panel)",
  "border-radius": "12px",
  "box-shadow": "0 8px 24px rgb(0 0 0 / 0.35)",
  "pointer-events": "none",
  transition: "scale 150ms ease-out, box-shadow 150ms ease-out",
};
const LIST_STYLE = ["user-select", "-webkit-user-select", "-webkit-touch-callout"];

export type TouchDragHandlers = {
  /** The element to lift for a pressed `selector` match, or null when it can't move. */
  lift: (pressed: HTMLElement) => HTMLElement | null;
  over: (target: Element | null, y: number) => void;
  drop: (target: Element | null, y: number) => void;
  cancel: () => void;
};

type Press = {
  pressed: HTMLElement;
  lifted: HTMLElement | null;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  scrollTop: number;
  moved: boolean;
  timer: ReturnType<typeof setTimeout>;
  frame: number;
};

/** Long-press then drag for touch inside the returned scroll list ref; mouse and pen never start it. */
export function useTouchDrag(selector: string, handlers: TouchDragHandlers): (node: HTMLElement | null) => void {
  const [list, setList] = useState<HTMLElement | null>(null);
  const listRef = useCallback((node: HTMLElement | null) => setList(node), []);
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    if (!list) return;
    let press: Press | null = null;
    const hit = (x: number, y: number) => {
      const target = list.ownerDocument.elementFromPoint(x, y);
      return target && list.contains(target) ? target : null;
    };
    const follow = (current: Press) => {
      current.lifted?.style.setProperty("translate", `0 ${current.lastY - current.y + list.scrollTop - current.scrollTop}px`);
    };
    const release = () => {
      const done = press;
      if (!done) return null;
      press = null;
      clearTimeout(done.timer);
      cancelAnimationFrame(done.frame);
      if (done.lifted) {
        for (const key of [...Object.keys(LIFTED_STYLE), "translate"]) done.lifted.style.removeProperty(key);
        done.lifted.removeAttribute("data-touch-lifted");
      }
      for (const key of LIST_STYLE) list.style.removeProperty(key);
      return done;
    };
    const autoScroll = () => {
      if (!press?.lifted) return;
      const rect = list.getBoundingClientRect();
      const step = press.lastY < rect.top + SCROLL_EDGE ? -SCROLL_STEP : press.lastY > rect.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
      const before = list.scrollTop;
      if (step) list.scrollTop += step;
      if (list.scrollTop !== before) {
        follow(press);
        latest.current.over(hit(press.lastX, press.lastY), press.lastY);
      }
      press.frame = requestAnimationFrame(autoScroll);
    };
    const lift = () => {
      if (!press) return;
      const lifted = latest.current.lift(press.pressed);
      if (!lifted) {
        release();
        return;
      }
      press.lifted = lifted;
      for (const [key, value] of Object.entries(LIFTED_STYLE)) lifted.style.setProperty(key, value);
      lifted.setAttribute("data-touch-lifted", "");
      hapticTick();
      press.frame = requestAnimationFrame(autoScroll);
    };
    const cancel = () => {
      if (release()?.lifted) latest.current.cancel();
    };
    const onStart = (e: TouchEvent) => {
      cancel();
      const touch = e.touches[0];
      const pressed = e.target instanceof Element ? e.target.closest<HTMLElement>(selector) : null;
      if (e.touches.length !== 1 || !touch || !pressed || !list.contains(pressed)) return;
      for (const key of LIST_STYLE) list.style.setProperty(key, "none");
      press = {
        pressed,
        lifted: null,
        x: touch.clientX,
        y: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        scrollTop: list.scrollTop,
        moved: false,
        timer: setTimeout(lift, LONG_PRESS_MS),
        frame: 0,
      };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!press || !touch) return;
      const far = Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > LONG_PRESS_SLOP;
      if (!press.lifted) {
        if (far) release();
        return;
      }
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      press.lastX = touch.clientX;
      press.lastY = touch.clientY;
      press.moved ||= far;
      follow(press);
      latest.current.over(hit(press.lastX, press.lastY), press.lastY);
    };
    const onEnd = (e: TouchEvent) => {
      if (!press?.lifted) {
        release();
        return;
      }
      // cancelling the touchend is what stops the tap's click from opening the chat
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const done = release()!;
      if (done.moved) {
        latest.current.drop(hit(done.lastX, done.lastY), done.lastY);
        return;
      }
      latest.current.cancel();
      // a hold without a move is still the long-press menu
      hit(done.x, done.y)?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: done.x, clientY: done.y }),
      );
    };
    const onMenu = (e: Event) => {
      if (!press) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onScroll = () => {
      if (press && !press.lifted) release();
    };
    list.addEventListener("touchstart", onStart, { passive: true });
    list.addEventListener("touchmove", onMove, { passive: false });
    list.addEventListener("touchend", onEnd);
    list.addEventListener("touchcancel", cancel);
    list.addEventListener("contextmenu", onMenu, true);
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      list.removeEventListener("touchstart", onStart);
      list.removeEventListener("touchmove", onMove);
      list.removeEventListener("touchend", onEnd);
      list.removeEventListener("touchcancel", cancel);
      list.removeEventListener("contextmenu", onMenu, true);
      list.removeEventListener("scroll", onScroll);
      cancel();
    };
  }, [list, selector]);

  return listRef;
}
