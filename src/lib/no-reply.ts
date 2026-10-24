import { useEffect, useState } from "react";

import { t } from "./i18n";

/** One unbroken wait this long names the silent engine; 30 days of real waits never routinely ran past it. */
export const NO_REPLY_MS = 120_000;
const MINUTE = 60_000;

const ENGINE_NAMES = new Map([
  ["claudeAgent", "Claude"],
  ["codex", "Codex"],
  ["antigravityAgent", "Gemini"],
  ["geminiAgent", "Gemini"],
  ["grokAgent", "Grok"],
  ["museAgent", "Muse"],
]);

export function noReplyLabel(driverKind: string | undefined, minutes: number): string {
  return t("activity.noReply", { engine: ENGINE_NAMES.get(driverKind ?? "") ?? t("activity.noReplyModel"), n: minutes });
}

/** `wait` names one waiting span and is null outside one. `quiet` marks the per-minute updates after the first hint. */
export function useNoReply(wait: string | null, driverKind?: string): { label: string; quiet: boolean } | undefined {
  const [span, setSpan] = useState<{ wait: string; start: number; now: number; quiet: boolean } | null>(null);
  if ((span?.wait ?? null) !== wait) {
    const now = Date.now();
    setSpan(wait === null ? null : { wait, start: now, now, quiet: false });
  }
  useEffect(() => {
    if (!span) return;
    const waited = span.now - span.start;
    const timer = setTimeout(
      () => setSpan((s) => (s?.wait === span.wait ? { ...s, now: Date.now(), quiet: s.now - s.start >= NO_REPLY_MS } : s)),
      waited < NO_REPLY_MS ? NO_REPLY_MS - waited : MINUTE - (waited % MINUTE),
    );
    return () => clearTimeout(timer);
  }, [span]);
  if (!span || span.wait !== wait || span.now - span.start < NO_REPLY_MS) return undefined;
  return { label: noReplyLabel(driverKind, Math.floor((span.now - span.start) / MINUTE)), quiet: span.quiet };
}
