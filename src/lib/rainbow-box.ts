import { useSyncExternalStore } from "react";

export type RainbowBox = "off" | "rainbow" | "theme";
export const RAINBOW_BOX_KEY = "omb-rainbow-box";
const watchers = new Set<() => void>();

// "on" is the stored value from when the box was a rainbow-only switch.
function readRainbowBox(): RainbowBox {
  try {
    const value = localStorage.getItem(RAINBOW_BOX_KEY);
    return value === "on" ? "rainbow" : value === "theme" ? "theme" : "off";
  } catch {
    return "off";
  }
}

let mode = readRainbowBox();

export function rainbowBoxMode(): RainbowBox {
  return mode;
}

export function saveRainbowBox(value: RainbowBox): void {
  mode = value;
  try {
    localStorage.setItem(RAINBOW_BOX_KEY, value === "rainbow" ? "on" : value);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useRainbowBox(): RainbowBox {
  return useSyncExternalStore(subscribe, rainbowBoxMode, rainbowBoxMode);
}
