// Shared hook over the preload's updater bridge. Returns null in the
// browser / when the bridge is absent (dev) — callers render nothing then.
// onState emits the current state immediately on subscribe, so a component
// mounted after the download finished still sees "downloaded".
import { useCallback, useEffect, useState } from "react";
import type { UpdaterState } from "@/types/ogb";

export type { UpdaterState };

export function useUpdaterState(): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => window.ogb?.updater?.onState(setState), []);
  return window.ogb?.updater ? state : null;
}

/** How long a finished manual check stays acknowledged. */
const ACK_MS = 3000;

/** Runs a manual check and reports when it finished with nothing to install.
 * The window opens when the RESULT lands, not on the click — timing it from
 * the click meant a check slower than the window finished silently. */
export function useManualCheck(status: string) {
  const [ackAt, setAckAt] = useState(0);
  const check = useCallback(() => {
    setAckAt(0);
    void window.ogb?.updater?.check().finally(() => setAckAt(Date.now()));
  }, []);
  useEffect(() => {
    if (!ackAt) return;
    const timer = setTimeout(() => setAckAt(0), ACK_MS);
    return () => clearTimeout(timer);
  }, [ackAt]);
  // a check that found something shows that instead — this is the empty result
  return { acknowledged: ackAt > 0 && status === "idle", check };
}
