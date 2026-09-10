import { useSyncExternalStore } from "react";

export type UsageMode = "used" | "remaining";
const KEY = "omb-usage-mode";
const watchers = new Set<() => void>();

function readUsageMode(): UsageMode {
  try {
    return localStorage.getItem(KEY) === "remaining" ? "remaining" : "used";
  } catch {
    return "used";
  }
}

let mode = readUsageMode();

export function getUsageMode(): UsageMode {
  return mode;
}

export function setUsageMode(value: UsageMode): void {
  mode = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useUsageMode(): UsageMode {
  return useSyncExternalStore(subscribe, getUsageMode, getUsageMode);
}
