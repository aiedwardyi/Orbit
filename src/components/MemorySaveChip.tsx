import { useEffect, useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { Message } from "@/state/store";

const FLICKER_MS = 700;

// Timed from the save, not the mount: a remount (bot switch) must not replay it.
function useSaved(at: number): boolean {
  const [settled, setSettled] = useState(() => (Date.now() - at >= FLICKER_MS ? at : -Infinity));
  useEffect(() => {
    const wait = Math.min(FLICKER_MS, FLICKER_MS - (Date.now() - at));
    if (wait <= 0) {
      setSettled(at);
      return;
    }
    const id = window.setTimeout(() => setSettled(at), wait);
    return () => window.clearTimeout(id);
  }, [at]);
  return settled >= at;
}

const ROW = "flex min-w-0 max-w-full items-center gap-2 border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary";

export function MemorySaveChip({ summary, at }: { summary: string; at: number }) {
  const { t } = useI18n();
  const saved = useSaved(at);
  return (
    <div className="flex justify-start">
      <div className={ROW}>
        {saved ? <Check size={13} className="shrink-0 text-success" /> : <Loader2 size={13} className="shrink-0 animate-spin" />}
        <span className="min-w-0 max-w-[480px] truncate">
          {saved ? t("chat.savedMemory", { summary }) : t("chat.savingMemory")}
        </span>
      </div>
    </div>
  );
}

/** Two or more saves in a row, folded to one row; `children` are the notes. */
export function MemorySaveRun({ messages, forceOpen = false, children }: { messages: Message[]; forceOpen?: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  const saved = useSaved(messages[messages.length - 1].at);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={`${ROW} rounded-lg hover:bg-control focus-visible:bg-control`}
        >
          {saved ? <Check size={13} className="shrink-0 text-success" /> : <Loader2 size={13} className="shrink-0 animate-spin" />}
          <span className="min-w-0 max-w-[480px] truncate">
            {saved ? t("chat.savedMemoryMany", { count: messages.length }) : t("chat.savingMemory")}
          </span>
          <ChevronRight size={13} className={open ? "shrink-0 rotate-90" : "shrink-0"} />
        </button>
      </div>
      {open && children}
    </div>
  );
}
