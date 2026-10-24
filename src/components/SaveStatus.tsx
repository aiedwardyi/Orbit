import { Check } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { usePresence } from "@/lib/use-presence";
import { botPatchStatus, watchBotPatchStatus, type BotProfileField } from "@/state/bot-patch-status";

export function SaveStatus({ status }: { status: "idle" | "saving" | "saved" }) {
  const { t } = useI18n();
  const { mounted, closing, enter, value } = usePresence(status === "idle" ? null : status);
  return (
    <span role="status" className="text-[12px]">
      {mounted && (
        <span data-closing={closing || undefined} className={cn(enter && "animate-fade-in", "inline-flex items-center gap-1")}>
          {value === "saved" && <Check size={12} aria-hidden="true" />}
          {t(value === "saved" ? "bot.saved" : "bot.saving")}
        </span>
      )}
    </span>
  );
}

export function BotSaveStatus({ botId, field }: { botId: string; field: BotProfileField }) {
  const value = useSyncExternalStore(
    useCallback((changed) => watchBotPatchStatus(botId, changed), [botId]),
    () => botPatchStatus(botId, field),
    () => null,
  );
  const [expired, setExpired] = useState(0);
  useEffect(() => {
    if (value === null || value === "saving") return;
    const timer = setTimeout(() => setExpired(value), Math.max(0, value + 2000 - Date.now()));
    return () => clearTimeout(timer);
  }, [value]);
  const status = value === "saving" ? "saving" : value !== null && value > expired && value + 2000 > Date.now() ? "saved" : "idle";
  return <SaveStatus status={status} />;
}
