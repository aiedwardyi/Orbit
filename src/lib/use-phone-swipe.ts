import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  SWIPE_MOTION_MS,
  SWIPE_SPRING,
  dragOffset,
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

/** Phone-only horizontal swipe on `stage` to move between sidebar bots, plus the enter motion and haptic on any bot switch. */
export function usePhoneSwipe(
  stage: RefObject<HTMLElement | null>,
  botId: string | undefined,
  enabled: boolean,
  select: (id: string) => void,
) {
  const enterFrom = useRef<number | null>(null);
  const shownBot = useRef(botId);
  const latest = useRef({ botId, select });
  useLayoutEffect(() => {
    latest.current = { botId, select };
  });

  useLayoutEffect(() => {
    const from = shownBot.current;
    shownBot.current = botId;
    const el = stage.current;
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
  }, [botId, stage]);

  const hasBot = Boolean(botId);
  useEffect(() => {
    const el = stage.current;
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
  }, [stage, hasBot, enabled]);
}
