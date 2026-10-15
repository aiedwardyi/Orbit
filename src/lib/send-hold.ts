import type React from "react";

export const SEND_HOLD_MS = 500;
const SEND_HOLD_SLOP = 10;

let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
let guardUntil = 0;
let guarding = false;

function cancelPress(): void {
  if (press) clearTimeout(press.timer);
  press = null;
}

// The sent box unmounts Send under the finger, so the hold's own contextmenu
// and click land on whatever is there now: swallow them until the next touch.
function swallowHoldTail(e: Event): void {
  if (Date.now() >= guardUntil) return;
  e.preventDefault();
  e.stopPropagation();
}

function guardHoldTail(): void {
  guardUntil = Date.now() + 2 * SEND_HOLD_MS;
  if (guarding) return;
  guarding = true;
  document.addEventListener("contextmenu", swallowHoldTail, true);
  document.addEventListener("click", swallowHoldTail, true);
  document.addEventListener("touchstart", () => (guardUntil = 0), true);
}

/** Send button props: a tap sends now, a still one-finger hold sends after the running turn. */
export function holdToSendAfter(send: (after: boolean) => void) {
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      cancelPress();
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) return;
      press = {
        x: touch.clientX,
        y: touch.clientY,
        timer: setTimeout(() => {
          press = null;
          guardHoldTail();
          send(true);
        }, SEND_HOLD_MS),
      };
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const touch = e.touches[0];
      if (press && (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > SEND_HOLD_SLOP)) cancelPress();
    },
    onTouchEnd: cancelPress,
    onTouchCancel: cancelPress,
    onClick: () => send(false),
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => e.preventDefault(),
  };
}
