import { useSyncExternalStore } from "react";

export const RAINBOW_BOX_KEY = "omb-rainbow-box";
const watchers = new Set<() => void>();

function readRainbowBox(): boolean {
  try {
    return localStorage.getItem(RAINBOW_BOX_KEY) === "on";
  } catch {
    return false;
  }
}

let on = readRainbowBox();

export function rainbowBoxEnabled(): boolean {
  return on;
}

export function saveRainbowBox(value: boolean): void {
  on = value;
  try {
    localStorage.setItem(RAINBOW_BOX_KEY, value ? "on" : "off");
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useRainbowBox(): boolean {
  return useSyncExternalStore(subscribe, rainbowBoxEnabled, rainbowBoxEnabled);
}
