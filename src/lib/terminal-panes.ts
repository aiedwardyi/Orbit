import { useEffect, type Dispatch } from "react";
import { z } from "zod";

import { api, type Action } from "@/state/store";

export const PANE_COUNT_REFRESH_MS = 15_000;

const payloadSchema = z.object({
  counts: z.record(z.string(), z.number().int().min(1).max(8)).optional(),
  panes: z.record(z.string(), z.array(z.string()).min(1).max(8)).optional(),
});

type PaneCountPayload = { counts?: Record<string, number>; panes?: Record<string, string[]> };

/** Sidebar rows. Host labels when present, otherwise one blank slot per count. */
export function panesFromPayload(body: PaneCountPayload) {
  if (body.panes && Object.keys(body.panes).length > 0) return body.panes;
  const panes: Record<string, string[]> = {};
  for (const [botId, count] of Object.entries(body.counts ?? {})) panes[botId] = Array.from({ length: count }, () => "");
  return panes;
}

/** Mirrors open worker panes per bot into the store. Desktop uses the preload; a device window reads the host. */
export function useTerminalPanes(dispatch: Dispatch<Action>, terminalOpen = false): void {
  useEffect(() => {
    const terminal = window.ogb?.terminal;
    if (!terminal?.paneLabels) return;
    let alive = true;
    let latest = 0;
    const refresh = () => {
      const call = ++latest;
      void terminal.paneLabels?.()
        .then((panes) => {
          // an older call resolving late must not overwrite a newer count
          if (alive && call === latest) dispatch({ type: "setTerminalPanes", panes });
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

  useEffect(() => {
    if (window.ogb) return;
    let alive = true;
    let latest = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const call = ++latest;
      void api("/api/terminal/pane-counts")
        .then((body) => {
          const parsed = payloadSchema.safeParse(body);
          // an older read resolving late must not overwrite a newer count
          if (!alive || call !== latest || !parsed.success) return;
          dispatch({ type: "setTerminalPanes", panes: panesFromPayload(parsed.data) });
        })
        .catch(() => {});
    };
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, PANE_COUNT_REFRESH_MS);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [dispatch, terminalOpen]);
}
