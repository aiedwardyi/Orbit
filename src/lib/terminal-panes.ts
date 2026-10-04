import { useEffect, type Dispatch } from "react";
import type { Action } from "@/state/store";

/** Mirrors the desktop terminal host's open worker panes per bot into the store. */
export function useTerminalPanes(dispatch: Dispatch<Action>): void {
  useEffect(() => {
    const terminal = window.ogb?.terminal;
    if (!terminal?.paneLabels) return;
    let alive = true;
    const refresh = () => {
      void terminal.paneLabels?.()
        .then((panes) => {
          if (alive) dispatch({ type: "setTerminalPanes", panes });
        })
        .catch(() => {});
    };
    refresh();
    const offs = [terminal.onOpened?.(refresh), terminal.onClosed?.(refresh), terminal.onExit(refresh)];
    return () => {
      alive = false;
      for (const off of offs) off?.();
    };
  }, [dispatch]);
}
