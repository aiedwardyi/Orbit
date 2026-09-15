import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function MemorySaveChip({ summary }: { summary: string }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSaved(true), 700);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
        {saved ? <Check size={13} className="text-success" /> : <Loader2 size={13} className="animate-spin" />}
        <span className="max-w-[480px] truncate">
          {saved ? t("chat.savedMemory", { summary }) : t("chat.savingMemory")}
        </span>
      </div>
    </div>
  );
}
