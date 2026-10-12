/**
 * Ctrl/Cmd zoom for the desktop window. Chromium's default Ctrl++ binding
 * is numpad-plus / Shift+=; Windows users press Ctrl+= and expect zoom in
 * to work the same as zoom out.
 */
export function zoomShortcut(input) {
  if (!input || (input.type && input.type !== "keyDown")) return null;
  const mod = Boolean(input.control) || Boolean(input.meta);
  if (!mod || input.alt) return null;
  const key = String(input.key ?? "");
  if (key === "=" || key === "+" || key === "Add") return "in";
  if (key === "-" || key === "_" || key === "Subtract") return "out";
  if (key === "0" || key === "Numpad0") return "reset";
  return null;
}

// Chromium zooms 1.2x per level, so half a level is about 10% per press.
const ZOOM_STEP = 0.5;

export function applyZoomShortcut(webContents, input) {
  const action = zoomShortcut(input);
  if (!action || !webContents) return false;
  try {
    if (action === "in") webContents.setZoomLevel(webContents.getZoomLevel() + ZOOM_STEP);
    else if (action === "out") webContents.setZoomLevel(webContents.getZoomLevel() - ZOOM_STEP);
    else webContents.setZoomLevel(0);
    return true;
  } catch {
    return false;
  }
}

const imageZoomOwners = new Set();
const savedWindowZoom = new Map();

export function setImageZoomOwned(webContentsId, owned, currentLevel) {
  if (owned) {
    if (!imageZoomOwners.has(webContentsId)) {
      savedWindowZoom.set(webContentsId, Number.isFinite(currentLevel) ? currentLevel : 0);
    }
    imageZoomOwners.add(webContentsId);
    return;
  }
  imageZoomOwners.delete(webContentsId);
  savedWindowZoom.delete(webContentsId);
}

/** Puts back the zoom level from when the viewer claimed the keys. */
export function restoreWindowZoom(webContents) {
  if (!webContents || !imageZoomOwners.has(webContents.id)) return false;
  const saved = savedWindowZoom.get(webContents.id);
  if (saved === undefined) return false;
  try {
    if (webContents.getZoomLevel() === saved) return false;
    webContents.setZoomLevel(saved);
    return true;
  } catch {
    return false;
  }
}

export function routeZoomShortcut(webContents, input) {
  const action = zoomShortcut(input);
  if (!action || !webContents) return null;
  if (imageZoomOwners.has(webContents.id)) return { target: "image", action };
  return applyZoomShortcut(webContents, input) ? { target: "window", action } : null;
}
