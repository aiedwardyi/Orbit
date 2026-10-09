import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const FLICKER_MS = 700;

export function MemorySaveChip({ summary, at }: { summary: string; at: number }) {
  const { t } = useI18n();
  // Timed from the save, not the mount: a remount (bot switch) must not replay it.
  const [saved, setSaved] = useState(() => Date.now() - at >= FLICKER_MS);
  useEffect(() => {
    const wait = Math.min(FLICKER_MS, FLICKER_MS - (Date.now() - at));
    if (wait <= 0) return;
    const id = window.setTimeout(() => setSaved(true), wait);
    return () => window.clearTimeout(id);
  }, [at]);
  return (
    <div className="flex justify-start">
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
        {saved ? <Check size={13} className="shrink-0 text-success" /> : <Loader2 size={13} className="shrink-0 animate-spin" />}
        <span className="min-w-0 max-w-[480px] truncate">
          {saved ? t("chat.savedMemory", { summary }) : t("chat.savingMemory")}
        </span>
      </div>
    </div>
  );
}
