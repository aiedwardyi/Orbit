import { useEffect, useRef, useState, type ReactNode } from "react";

import { reducedMotion } from "./phone-swipe";

// matches the [data-closing] fade in styles.css
export const PRESENCE_EXIT_MS = 130;

export type Presence<T> = { mounted: boolean; closing: boolean; value: T };

/** Keeps a closed surface mounted, marked closing, for its exit fade; `value` holds the last open one until it unmounts. */
export function usePresence<T>(when: T): Presence<T> {
  const open = Boolean(when);
  const [shown, setShown] = useState(open);
  const last = useRef(when);
  if (open) last.current = when;
  if (open && !shown) setShown(true);
  if (!open && shown && reducedMotion()) setShown(false);
  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => setShown(false), PRESENCE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, shown]);
  return { mounted: open || shown, closing: !open && shown, value: open || !shown ? when : last.current };
}

export function Presence({ open, children }: { open: boolean; children: (closing: boolean) => ReactNode }) {
  const { mounted, closing } = usePresence(open);
  return mounted ? children(closing) : null;
}
