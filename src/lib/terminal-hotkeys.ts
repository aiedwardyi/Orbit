/** Ctrl+` toggles the terminal here. The desktop needs its preload; a device window does not. */
export function backquoteTogglesTerminal(hasPreload: boolean, desktopTerminal: boolean): boolean {
  return desktopTerminal || !hasPreload;
}

/** Alt+digit picks a pane. Desktop uses the preload; a window with no preload uses the remote view. */
export function altDigitSelectsPane(desktopTerminal: boolean, webWindow: boolean): boolean {
  return desktopTerminal || webWindow;
}
