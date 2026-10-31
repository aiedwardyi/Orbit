import { useEffect, useState } from "react";

import { api } from "@/state/store";

export const CATCHING_UP_POLL_MS = 2_000;

/** Whether this PC is still pulling what the chat missed; polls only until the server says it caught up. */
export function useCatchingUp(threadId: string | null): boolean {
  const [catchingUp, setCatchingUp] = useState(false);
  useEffect(() => {
    setCatchingUp(false);
    if (!threadId) return;
    let live = true;
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (asking) return;
      asking = true;
      clearTimeout(timer);
      api(`/api/catching-up/${encodeURIComponent(threadId)}`)
        .then((body: { catchingUp: boolean | null }) => {
          if (!live) return;
          setCatchingUp(body.catchingUp === true);
          if (body.catchingUp !== false) timer = setTimeout(check, CATCHING_UP_POLL_MS);
        })
        .catch(() => {})
        .finally(() => { asking = false; });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId]);
  return catchingUp;
}
