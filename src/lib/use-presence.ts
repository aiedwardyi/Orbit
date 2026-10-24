import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { reducedMotion } from "./phone-swipe";

// matches the [data-closing] fade in styles.css
export const PRESENCE_EXIT_MS = 130;

export type Presence<T> = { mounted: boolean; closing: boolean; enter: boolean; value: T; cut: () => void };

/** Keeps a closed surface mounted, marked closing, for its exit fade; `value` holds the last open one until it unmounts.
 * Only an open from fully shut sets `enter`, so a surface open at mount or reopened mid-close shows at once. */
export function usePresence<T>(when: T): Presence<T> {
  const open = Boolean(when);
  const [shown, setShown] = useState(open);
  const [enter, setEnter] = useState(false);
  const last = useRef(when);
  if (open) last.current = when;
  if (open && !shown) {
    setShown(true);
    setEnter(true);
  }
  if (!open && enter) setEnter(false);
  if (!open && shown && reducedMotion()) setShown(false);
  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => setShown(false), PRESENCE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, shown]);
  // for a close the user did not ask for, such as a view switch
  const cut = useCallback(() => setShown(false), []);
  return { mounted: open || shown, closing: !open && shown, enter, value: open || !shown ? when : last.current, cut };
}

/** False through the first commit, for an open state that lags a chat switch by one. */
export function useSettled(already = false) {
  const [settled, setSettled] = useState(already);
  useEffect(() => setSettled(true), []);
  return settled;
}

type PresenceProps = { open: boolean; children: (closing: boolean, enter: boolean) => ReactNode };

function Shown({ open, children }: PresenceProps) {
  const { mounted, closing, enter } = usePresence(open);
  return mounted ? children(closing, enter) : null;
}

/** With `afterMount`, an open that lags a chat switch by a commit never shows, and one still standing after it shows at once. */
export function Presence({ open, afterMount = false, children }: PresenceProps & { afterMount?: boolean }) {
  const settled = useSettled(!afterMount);
  return settled ? createElement(Shown, { open, children }) : null;
}
