/**
 * Platform window chrome. macOS keeps inset traffic lights. Windows uses a
 * hidden title bar with a native titleBarOverlay so caption buttons stay OS-
 * owned (Snap, min/max/close) while matching the active skin. Linux stays
 * native. The overlay paints on top of renderer content, so the app reserves
 * a global 32px top inset before enabling it.
 */
export const WINDOWS_CAPTION_HEIGHT = 32;

const DEFAULT_CHROME = Object.freeze({ color: "#070707", symbolColor: "#b5b5b5" });

export function titleBarOverlayOptions(chrome = DEFAULT_CHROME) {
  return {
    color: chrome.color ?? DEFAULT_CHROME.color,
    symbolColor: chrome.symbolColor ?? DEFAULT_CHROME.symbolColor,
    height: WINDOWS_CAPTION_HEIGHT,
  };
}

export function windowChromeOptions(platform, chrome = DEFAULT_CHROME) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlayOptions(chrome),
    };
  }
  return {};
}

/** Recolor the Windows overlay after a skin change. No-op elsewhere. */
export function applyWindowsTitleBarOverlay(win, chrome) {
  if (!win || win.isDestroyed?.()) return false;
  if (typeof win.setTitleBarOverlay !== "function") return false;
  try {
    win.setTitleBarOverlay(titleBarOverlayOptions(chrome));
    return true;
  } catch {
    return false;
  }
}
