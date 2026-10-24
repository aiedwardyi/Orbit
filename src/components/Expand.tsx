import { useLayoutEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { usePresence } from "@/lib/use-presence";

export function ExpandFrame({ closing, enter, className, children }: { closing: boolean; enter: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // inert alone leaves focus in a closing frame until the browser's lazy fixup
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (closing && active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
  }, [closing]);
  return (
    <div ref={ref} data-expand="" data-closing={closing || undefined} inert={closing} className={cn(enter && "animate-expand-in", "grid", className)}>
      {/* padding here would set the folded height */}
      <div className="min-h-0 min-w-0">{children}</div>
    </div>
  );
}

/** `instant` opens at the end state, for an open the user did not make, such as a search landing. */
export function Expand({ open, instant = false, className, children }: { open: boolean; instant?: boolean; className?: string; children: ReactNode }) {
  const { mounted, closing, enter } = usePresence(open);
  return mounted ? <ExpandFrame closing={closing} enter={enter && !instant} className={className}>{children}</ExpandFrame> : null;
}
