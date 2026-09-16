const KEY = "omb-terminal-match-profile";
export const TERMINAL_APPEARANCE_EVENT = "orbit-terminal-appearance";

export function readTerminalMatch(): boolean {
  try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}

export function applyTerminalMatch(enabled: boolean): void {
  localStorage.setItem(KEY, String(enabled));
  window.dispatchEvent(new Event(TERMINAL_APPEARANCE_EVENT));
}
