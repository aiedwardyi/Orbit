import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useStore } from "@/state/store";

// A woken phone or a network blip reconnects well inside this; a PC that went away does not.
const GRACE_MS = 2_000;

export function ReconnectingCue() {
  const { t } = useI18n();
  const { state } = useStore();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (state.connected) return;
    const id = window.setTimeout(() => setShown(true), GRACE_MS);
    return () => window.clearTimeout(id);
  }, [state.connected]);
  if (!shown) return null;
  return (
    <div className="flex w-full justify-center px-5">
      <div role="status" className="mb-2 flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
        <Loader2 size={13} className="animate-spin" />
        {t("activity.reconnecting")}
      </div>
    </div>
  );
}
