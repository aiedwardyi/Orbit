import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SidebarSide } from "./sidebar-preferences";
import {
  SWIPE_MOTION_MS,
  SWIPE_SPRING,
  dragOffset,
  drawerOffset,
  drawerSwipeCloses,
  hapticTick,
  isPhone,
  lockAxis,
  neighborId,
  reducedMotion,
  sidebarBotIds,
  swipeBlocked,
  swipeStep,
  type SwipeAxis,
} from "./phone-swipe";

type Drag = {
  x: number;
  y: number;
  lastX: number;
  lastT: number;
  velocity: number;
  axis: SwipeAxis;
  ids: string[];
};

const TAP_ENTER_PX = 32;

function settle(stage: HTMLElement, from: number, to: number, opacity = 1) {
  stage.style.transform = "";
  if (reducedMotion() || typeof stage.animate !== "function") return;
  stage.animate(
    [{ transform: `translateX(${from}px)`, opacity }, { transform: `translateX(${to}px)`, opacity: 1 }],
    { duration: SWIPE_MOTION_MS, easing: SWIPE_SPRING },
  );
}

/** Phone-only horizontal swipe on the returned stage ref to move between sidebar bots, plus the enter motion and haptic on any bot switch. */
export function usePhoneSwipe(
  botId: string | undefined,
  enabled: boolean,
  select: (id: string) => void,
): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const stage = useCallback((node: HTMLElement | null) => setEl(node), []);

  const enterFrom = useRef<number | null>(null);
  const shownBot = useRef(botId);
  const latest = useRef({ botId, select });
  useLayoutEffect(() => {
    latest.current = { botId, select };
  });

  useLayoutEffect(() => {
    const from = shownBot.current;
    shownBot.current = botId;
    if (!from || !botId || from === botId || !el || !isPhone()) return;
    hapticTick();
    if (enterFrom.current !== null) {
      settle(el, enterFrom.current, 0);
      enterFrom.current = null;
      return;
    }
    const ids = sidebarBotIds();
    const dir = Math.sign(ids.indexOf(botId) - ids.indexOf(from));
    settle(el, ids.includes(from) && ids.includes(botId) ? dir * TAP_ENTER_PX : 0, 0, 0);
  }, [botId, el]);

  const hasBot = Boolean(botId);
  useEffect(() => {
    if (!el || !hasBot || !enabled) return;
    let drag: Drag | null = null;
    const onStart = (e: TouchEvent) => {
      if (drag?.axis === "x") el.style.transform = "";
      drag = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || !isPhone() || swipeBlocked(e.target, touch.clientX)) return;
      el.getAnimations?.().forEach((animation) => animation.cancel());
      drag = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: e.timeStamp, velocity: 0, axis: null, ids: sidebarBotIds() };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      drag.axis ??= lockAxis(dx, touch.clientY - drag.y);
      if (drag.axis !== "x") {
        if (drag.axis === "y") drag = null;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = e.timeStamp;
      const canMove = neighborId(drag.ids, latest.current.botId ?? "", dx < 0 ? 1 : -1) !== null;
      el.style.transform = `translateX(${dragOffset(dx, canMove)}px)`;
    };
    const finish = (commit: boolean) => {
      if (drag?.axis !== "x") {
        drag = null;
        return;
      }
      const { botId: current = "", select: go } = latest.current;
      const dx = drag.lastX - drag.x;
      const width = el.clientWidth || window.innerWidth;
      const step = commit ? swipeStep(dx, drag.velocity, width) : 0;
      const target = neighborId(drag.ids, current, step);
      const canMove = neighborId(drag.ids, current, dx < 0 ? 1 : -1) !== null;
      drag = null;
      if (!target) {
        settle(el, dragOffset(dx, canMove), 0);
        return;
      }
      enterFrom.current = dx + step * width;
      el.style.transform = "";
      go(target);
    };
    const onEnd = () => finish(true);
    const onCancel = () => finish(false);
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      el.style.transform = "";
    };
  }, [el, hasBot, enabled]);

  return stage;
}

type DrawerDrag = Omit<Drag, "ids"> & { drawer: HTMLElement; scrim: HTMLElement | null };

const DRAWER_STYLE = ["translate", "opacity", "transition"];

function clearDrawerStyle(...els: (HTMLElement | null)[]) {
  for (const node of els) for (const key of DRAWER_STYLE) node?.style.removeProperty(key);
}

/** Phone-only swipe on the open drawer or its scrim toward the drawer's edge, closing it through `close`. The returned ref goes on their shared parent. */
export function useDrawerSwipe(open: boolean, side: SidebarSide, close: () => void): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const shell = useCallback((node: HTMLElement | null) => setEl(node), []);
  const latest = useRef({ side, close });
  useLayoutEffect(() => {
    latest.current = { side, close };
  });

  useEffect(() => {
    if (!el || !open) return;
    const drawer = el.querySelector<HTMLElement>("[data-phone-drawer]");
    const scrim = el.querySelector<HTMLElement>("[data-phone-drawer-scrim]");
    if (!drawer) return;
    let drag: DrawerDrag | null = null;
    let springTimer: ReturnType<typeof setTimeout> | undefined;
    const onStart = (e: TouchEvent) => {
      clearTimeout(springTimer);
      clearDrawerStyle(drawer, scrim);
      drag = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || !isPhone() || !(e.target instanceof Node)) return;
      if (!drawer.contains(e.target) && !scrim?.contains(e.target)) return;
      if (swipeBlocked(e.target, touch.clientX)) return;
      drag = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: e.timeStamp, velocity: 0, axis: null, drawer, scrim };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      drag.axis ??= lockAxis(dx, touch.clientY - drag.y);
      if (drag.axis !== "x") {
        if (drag.axis === "y") drag = null;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = e.timeStamp;
      if (reducedMotion()) return;
      const offset = drawerOffset(dx, latest.current.side);
      drawer.style.transition = "none";
      drawer.style.translate = `${offset}px`;
      if (scrim) {
        scrim.style.transition = "none";
        scrim.style.opacity = String(1 - Math.abs(offset) / (drawer.offsetWidth || window.innerWidth));
      }
    };
    const finish = (commit: boolean, e: TouchEvent) => {
      if (drag?.axis !== "x") {
        drag = null;
        return;
      }
      // cancelling the touchend is what keeps a drag from ending in a click
      if (e.cancelable) e.preventDefault();
      const { side: edge, close: shut } = latest.current;
      const width = drawer.offsetWidth || window.innerWidth;
      const closes = commit && drawerSwipeCloses(drag.lastX - drag.x, drag.velocity, width, edge);
      drag = null;
      if (reducedMotion()) {
        clearDrawerStyle(drawer, scrim);
      } else {
        const motion = `${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
        drawer.style.transition = `translate ${motion}`;
        drawer.style.translate = closes ? (edge === "left" ? "-100%" : "100%") : "0px";
        if (scrim) {
          scrim.style.transition = `opacity ${motion}`;
          scrim.style.opacity = closes ? "0" : "1";
        }
        if (!closes) springTimer = setTimeout(() => clearDrawerStyle(drawer, scrim), SWIPE_MOTION_MS);
      }
      if (!closes) return;
      hapticTick();
      shut();
    };
    const onEnd = (e: TouchEvent) => finish(true, e);
    const onCancel = (e: TouchEvent) => finish(false, e);
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      clearTimeout(springTimer);
      // the closed class already sits where a swipe-close left the drawer, so this never jumps
      clearDrawerStyle(drawer, scrim);
    };
  }, [el, open]);

  return shell;
}
