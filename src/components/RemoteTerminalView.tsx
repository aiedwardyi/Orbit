import { useCallback, useEffect, useState } from "react";
import { Check, Copy, RotateCcw, TerminalSquare, X } from "lucide-react";
import type { Bot } from "@/state/store";
import { api } from "@/state/store";
import { useI18n } from "@/lib/i18n";

type RemoteTerminalSnapshot = {
  screenText?: string;
  recentText?: string;
  state?: "no-terminal";
  sessionId?: string;
  generation?: number;
  cwd?: string;
  exited?: boolean;
  exitCode?: number | null;
};

const REFRESH_MS = 3_000;

export function snapshotText(snapshot: RemoteTerminalSnapshot): string {
  return [snapshot.screenText, snapshot.recentText].filter(Boolean).join("\n\n");
}

export function RemoteTerminalView({
  bot,
  onClose,
  visible,
}: {
  bot: Pick<Bot, "id" | "name">;
  onClose: () => void;
  visible: boolean;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<RemoteTerminalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api(`/api/bots/${encodeURIComponent(bot.id)}/terminal`));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bot.id]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const noTerminal = snapshot?.state === "no-terminal";
  const text = snapshot && !noTerminal ? snapshotText(snapshot) : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const buttonClass =
    "flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text disabled:opacity-50";

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset text-ink" aria-label={t("terminal.title")}>
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-panel py-2 pl-11 pr-2 md:pl-5">
        <TerminalSquare size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{t("terminal.title")} <span className="text-ink-secondary">/ {bot.name}</span></h1>
          <p className="truncate font-mono text-[11px] text-ink-secondary">
            {[snapshot?.cwd, noTerminal ? t("terminal.noSession") : snapshot?.exited ? t("terminal.exited", { code: snapshot.exitCode ?? "?" }) : ""].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} aria-label={t("terminal.refresh")} className={buttonClass}>
          <RotateCcw size={16} /> <span className="max-sm:sr-only">{t("terminal.refresh")}</span>
        </button>
        <button type="button" onClick={() => void copy()} disabled={!text} aria-label={t("terminal.copy")} className={buttonClass}>
          {copied ? <Check size={16} /> : <Copy size={16} />} <span className="max-sm:sr-only">{t("terminal.copy")}</span>
        </button>
        <button type="button" onClick={onClose} aria-label={t("terminal.close")} className={buttonClass}>
          <X size={18} />
        </button>
      </header>
      {error && <p role="alert" className="shrink-0 border-b border-hairline px-4 py-2 text-[12px] text-ink-secondary">{t("terminal.unavailable")}: {error}</p>}
      {noTerminal ? (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-ink-secondary">{t("terminal.noSession")}</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed select-text">{text}</pre>
      )}
    </main>
  );
}
