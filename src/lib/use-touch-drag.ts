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
  // own layer, so following the finger doesn't re-raster the blurred shadow every frame
  "will-change": "translate",
  transition: "scale 150ms ease-out, box-shadow 150ms ease-out",
};
const LIST_STYLE = ["user-select", "-webkit-user-select", "-webkit-touch-callout"];
// one overlay moved by translate: marking the target itself relaid out and repainted the page per row crossed
const MARKER_STYLE: Record<string, string> = {
  position: "absolute",
  top: "0",
  left: "0",
  "z-index": "10",
  "pointer-events": "none",
  "border-radius": "9999px",
  background: "var(--color-accent)",
  "will-change": "translate, opacity",
  opacity: "0",
};
const MARK_INSET: Record<TouchDropMark, number> = { top: 8, bottom: 8, into: 4 };
const MARK_HEIGHT: Record<TouchDropMark, number> = { top: 2, bottom: 2, into: 4 };

export type TouchDropMark = "top" | "bottom" | "into";

export type TouchDragHandlers = {
  /** The element to lift for a pressed `selector` match, or null when it can't move. */
  lift: (pressed: HTMLElement) => HTMLElement | null;
  /** The element to mark with `data-touch-drop` and the drop marker, so a move never re-renders the list. */
  over: (target: Element | null, y: number) => [HTMLElement, TouchDropMark] | null;
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
  dirty: boolean;
  marked: [HTMLElement, TouchDropMark] | null;
  marker: HTMLElement | null;
  // in scroll content coordinates, dropped when the list's DOM changes
  targets: { el: HTMLElement; left: number; right: number; top: number; bottom: number }[] | null;
  timer: ReturnType<typeof setTimeout>;
  frame: number;
  unbind: () => void;
};

/** Long-press then drag for touch inside the returned scroll list ref; mouse and pen never start it. Moves aim at the innermost `targets` match. */
export function useTouchDrag(selector: string, targets: string, handlers: TouchDragHandlers): (node: HTMLElement | null) => void {
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
    // not elementFromPoint: it walks every layer painted after the point, so rows high in a long list lagged
    const under = (current: Press, x: number, y: number) => {
      const box = list.getBoundingClientRect();
      if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return null;
      current.targets ??= [...list.querySelectorAll<HTMLElement>(targets)]
        .filter((el) => !current.lifted?.contains(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, left: rect.left, right: rect.right, top: rect.top + list.scrollTop, bottom: rect.bottom + list.scrollTop };
        });
      const top = y + list.scrollTop;
      // innermost wins: a descendant always follows its ancestor
      for (let i = current.targets.length - 1; i >= 0; i--) {
        const target = current.targets[i]!;
        if (x >= target.left && x < target.right && top >= target.top && top < target.bottom) return target.el;
      }
      return null;
    };
    const observer = new MutationObserver(() => {
      if (press) press.targets = null;
    });
    const follow = (current: Press) => {
      current.lifted?.style.setProperty("translate", `0 ${current.lastY - current.y + list.scrollTop - current.scrollTop}px`);
    };
    const draw = (marker: HTMLElement, next: [HTMLElement, TouchDropMark] | null) => {
      // an unchanged write can still invalidate paint, and most crossings only move the marker
      const set = (key: string, value: string) => {
        if (marker.style.getPropertyValue(key) !== value) marker.style.setProperty(key, value);
      };
      if (!next) {
        set("opacity", "0");
        return;
      }
      const [el, mark] = next;
      const box = list.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const top = rect.top - box.top - list.clientTop + list.scrollTop;
      const y = mark === "bottom" ? top + rect.height - MARK_HEIGHT[mark] : top;
      set("width", `${rect.width - 2 * MARK_INSET[mark]}px`);
      set("height", `${MARK_HEIGHT[mark]}px`);
      set("translate", `${rect.left - box.left - list.clientLeft + MARK_INSET[mark]}px ${y}px`);
      set("box-shadow", mark === "into" ? "0 0 8px color-mix(in oklab, var(--color-accent) 60%, transparent)" : "none");
      set("opacity", "1");
    };
    const aim = (current: Press) => {
      const next = latest.current.over(under(current, current.lastX, current.lastY), current.lastY);
      if (next?.[0] === current.marked?.[0] && next?.[1] === current.marked?.[1]) return;
      current.marked?.[0].removeAttribute("data-touch-drop");
      next?.[0].setAttribute("data-touch-drop", next[1]);
      current.marked = next;
      if (current.marker) draw(current.marker, next);
    };
    const release = () => {
      const done = press;
      if (!done) return null;
      press = null;
      clearTimeout(done.timer);
      cancelAnimationFrame(done.frame);
      done.unbind();
      observer.disconnect();
      done.marked?.[0].removeAttribute("data-touch-drop");
      if (done.marker) {
        done.marker.remove();
        list.style.removeProperty("position");
      }
      if (done.lifted) {
        for (const key of [...Object.keys(LIFTED_STYLE), "translate"]) done.lifted.style.removeProperty(key);
        done.lifted.removeAttribute("data-touch-lifted");
      }
      for (const key of LIST_STYLE) list.style.removeProperty(key);
      return done;
    };
    // one hit test and style write per frame, however many touchmoves arrive
    const tick = () => {
      if (!press?.lifted) return;
      const rect = list.getBoundingClientRect();
      const step = press.lastY < rect.top + SCROLL_EDGE ? -SCROLL_STEP : press.lastY > rect.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
      const before = list.scrollTop;
      if (step) list.scrollTop += step;
      if (press.dirty || list.scrollTop !== before) {
        press.dirty = false;
        aim(press);
        follow(press);
      }
      press.frame = requestAnimationFrame(tick);
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
      const marker = list.ownerDocument.createElement("div");
      for (const [key, value] of Object.entries(MARKER_STYLE)) marker.style.setProperty(key, value);
      marker.setAttribute("data-touch-drop-marker", "");
      list.style.setProperty("position", "relative");
      list.append(marker);
      press.marker = marker;
      observer.observe(list, { childList: true, subtree: true });
      hapticTick();
      press.frame = requestAnimationFrame(tick);
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
        dirty: false,
        marked: null,
        marker: null,
        targets: null,
        timer: setTimeout(lift, LONG_PRESS_MS),
        frame: 0,
        unbind: () => {},
      };
      // React removing the pressed node stops its touches bubbling to the list
      const node = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (node && node !== list) {
        node.addEventListener("touchmove", onMove, { passive: false });
        node.addEventListener("touchend", onEnd);
        node.addEventListener("touchcancel", cancel);
        press.unbind = () => {
          node.removeEventListener("touchmove", onMove);
          node.removeEventListener("touchend", onEnd);
          node.removeEventListener("touchcancel", cancel);
        };
      }
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
      press.dirty = true;
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
        latest.current.drop(under(done, done.lastX, done.lastY), done.lastY);
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
  }, [list, selector, targets]);

  return listRef;
}
