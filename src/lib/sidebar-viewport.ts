import { useSyncExternalStore } from "react";
import { CHAT_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "./sidebar-preferences";

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useSidebarViewportWidth(asideWidth: number): number {
  // Wider viewports cannot change a fitted sidebar.
  const read = () => Math.min(window.innerWidth, CHAT_MIN_WIDTH + SIDEBAR_MAX_WIDTH + asideWidth);
  return useSyncExternalStore(subscribe, read, read);
}
