import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { hapticTick, lockAxis, reducedMotion, type SwipeAxis } from "./phone-swipe";

const SHIFT_PX = 40;
const SAMPLE_MS = 100;
const FLICK_MIN = 0.3;
const FLICK_MAX = 3;
const DECAY_MS = 300;
const REST = 0.05;
const WAIT_MS = 500;

type Moves = { step: (dir: number) => void; shift: (dir: number) => void };
type Drag = { id: number; x: number; y: number; from: number; axis: SwipeAxis; shifted: boolean; samples: { y: number; t: number }[] };

/** Phone dial: a vertical drag turns models, a flick coasts and snaps to the nearest one, a horizontal swipe moves effort one notch. */
export function useDialTouch(ref: RefObject<HTMLElement | null>, enabled: boolean, index: number, pitch: number, moves: Moves): void {
  const latest = useRef({ moves, pitch });
  latest.current = { moves, pitch };
  // Travel in px (down is positive), model steps landed and the one still rendering.
  const spin = useRef({ pos: 0, done: 0, pending: 0, sent: 0, run: () => {} });

  useLayoutEffect(() => {
    const state = spin.current;
    if (!state.pending) return;
    state.done += state.pending;
    state.pending = 0;
    hapticTick();
    state.run();
  }, [index]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const state = spin.current;
    let drag: Drag | null = null;
    let velocity = 0;
    let frame = 0;
    let at = 0;
    let dragged = false;

    const goal = () => -Math.round(state.pos / latest.current.pitch);
    const tick = (now: number) => {
      frame = 0;
      if (!drag && velocity) {
        const dt = Math.min(now - at, 50);
        state.pos += velocity * dt;
        velocity *= Math.exp(-dt / DECAY_MS);
        if (Math.abs(velocity) < REST) velocity = 0;
      }
      at = now;
      if (state.pending && now - state.sent > WAIT_MS) {
        state.pending = 0;
        velocity = 0;
        state.pos = -state.done * latest.current.pitch;
      }
      if (!state.pending && goal() !== state.done) {
        state.pending = Math.sign(goal() - state.done);
        state.sent = now;
        latest.current.moves.step(state.pending);
      }
      if (velocity || state.pending) frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (frame) return;
      at = performance.now();
      frame = requestAnimationFrame(tick);
    };
    state.run = run;

    const onDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      velocity = 0;
      dragged = false;
      state.pos = -(state.done + state.pending) * latest.current.pitch;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: state.pos, axis: null, shifted: false, samples: [] };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.axis) {
        drag.axis = lockAxis(dx, dy);
        if (!drag.axis) return;
        dragged = true;
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (drag.axis === "x") {
        if (drag.shifted || Math.abs(dx) < SHIFT_PX) return;
        drag.shifted = true;
        latest.current.moves.shift(Math.sign(dx));
        return;
      }
      const now = performance.now();
      drag.samples = [...drag.samples.filter((sample) => now - sample.t < SAMPLE_MS), { y: event.clientY, t: now }];
      state.pos = drag.from + dy;
      run();
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      const now = performance.now();
      const live = drag.samples.filter((sample) => now - sample.t < SAMPLE_MS);
      const [first, last] = [live[0], live.at(-1)];
      const speed = drag.axis === "y" && first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      velocity = event.type === "pointerup" && !reducedMotion() && Math.abs(speed) >= FLICK_MIN ? Math.max(-FLICK_MAX, Math.min(FLICK_MAX, speed)) : 0;
      drag = null;
      run();
    };
    const onClick = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    };
    // The picker's own touch stepper and the phone sidebar swipe listen above the dial.
    const hold = (event: TouchEvent) => event.stopPropagation();

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    el.addEventListener("touchstart", hold, { passive: true });
    el.addEventListener("touchmove", hold, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("touchstart", hold);
      el.removeEventListener("touchmove", hold);
    };
  }, [ref, enabled]);
}
