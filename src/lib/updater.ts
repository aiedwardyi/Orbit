// Shared hook over the preload's updater bridge. Returns null in the
// browser / when the bridge is absent (dev) - callers render nothing then,
// unless they opt into the remote fallback over /api/update and /api/events.
// onState emits the current state immediately on subscribe, so a component
// mounted after the download finished still sees "downloaded".
import { useCallback, useEffect, useState } from "react";
import { openLiveEvents, type LiveEventsPlatform } from "@/lib/live-events";
import { api } from "@/state/store";
import type { UpdaterState } from "@/types/ogb";

export type { UpdaterState };

type UpdaterActions = Pick<NonNullable<NonNullable<Window["ogb"]>["updater"]>, "check" | "download" | "install">;

/** The preload bridge on desktop; the server proxy to the desktop updater elsewhere. */
export function updaterActions(): UpdaterActions {
  return (
    window.ogb?.updater ?? {
      check: () => api("/api/update/check", { method: "POST" }),
      download: () => api("/api/update/download", { method: "POST" }),
      install: () => api("/api/update/install", { method: "POST" }),
    }
  );
}

/** Remote updater state: loaded on every fresh stream, then pushed as update.state frames. */
export function watchRemoteUpdater(
  onState: (s: UpdaterState | null) => void,
  load: () => Promise<UpdaterState | { status: "unavailable" }> = () => api("/api/update/state"),
  platform?: Partial<LiveEventsPlatform>,
): () => void {
  let alive = true;
  let pushed = 0;
  let loads = 0;
  const refresh = async () => {
    const seen = pushed;
    const generation = ++loads;
    try {
      const s = await load();
      // a pushed frame or a later load that landed meanwhile is newer than it
      if (alive && generation === loads && pushed === seen) onState(s.status === "unavailable" ? null : s);
      return true;
    } catch {
      // the desktop may be mid-restart; keep the last state and retry the stream
      return false;
    }
  };
  const stop = openLiveEvents(
    {
      screens: false,
      onSnapshotRequired: refresh,
      onFrame: (frame) => {
        if (frame.kind !== "update.state") return;
        pushed += 1;
        onState((frame as { state?: UpdaterState }).state ?? null);
      },
    },
    platform,
  );
  return () => {
    alive = false;
    stop();
  };
}

export function useUpdaterState(remote = false): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => {
    if (window.ogb?.updater) return window.ogb.updater.onState(setState);
    if (remote) return watchRemoteUpdater(setState);
  }, [remote]);
  return window.ogb?.updater || remote ? state : null;
}

/** How long a finished manual check stays acknowledged. */
const ACK_MS = 3000;

/** Runs a manual check and reports when it finished with nothing to install.
 * The window opens when the RESULT lands, not on the click — timing it from
 * the click meant a check slower than the window finished silently. */
export function useManualCheck(status: UpdaterState["status"]) {
  const [ackAt, setAckAt] = useState(0);
  const check = useCallback(() => {
    setAckAt(0);
    void updaterActions()
      .check()
      .catch(() => {})
      .finally(() => setAckAt(Date.now()));
  }, []);
  useEffect(() => {
    if (!ackAt) return;
    const timer = setTimeout(() => setAckAt(0), ACK_MS);
    return () => clearTimeout(timer);
  }, [ackAt]);
  // a check that found something shows that instead — this is the empty result
  return { acknowledged: ackAt > 0 && status === "idle", check };
}
