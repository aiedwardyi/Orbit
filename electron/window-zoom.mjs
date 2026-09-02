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

export function applyZoomShortcut(webContents, input) {
  const action = zoomShortcut(input);
  if (!action || !webContents) return false;
  try {
    if (action === "in") webContents.setZoomLevel(webContents.getZoomLevel() + 1);
    else if (action === "out") webContents.setZoomLevel(webContents.getZoomLevel() - 1);
    else webContents.setZoomLevel(0);
    return true;
  } catch {
    return false;
  }
}
