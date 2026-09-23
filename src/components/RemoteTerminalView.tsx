import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCcw, TerminalSquare, X } from "lucide-react";
import type { Bot } from "@/state/store";
import { api } from "@/state/store";
import { useI18n } from "@/lib/i18n";

type RemoteTerminalPane = {
  sessionId: string;
  label?: string | null;
  cwd?: string;
  main: boolean;
  exited?: boolean;
};

type RemoteTerminalSnapshot = {
  screenText?: string;
  recentText?: string;
  state?: "no-terminal";
  sessionId?: string;
  generation?: number;
  cwd?: string;
  exited?: boolean;
  exitCode?: number | null;
  label?: string | null;
  panes?: RemoteTerminalPane[];
};

const REFRESH_MS = 3_000;

export function snapshotText(snapshot: RemoteTerminalSnapshot): string {
  return [snapshot.screenText, snapshot.recentText].filter(Boolean).join("\n\n");
}

function folderName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || cwd;
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
  const [selectedPane, setSelectedPane] = useState<string | null>(null);
  const requestRef = useRef(0);
  const appliedRequestRef = useRef(0);

  const panes = snapshot?.panes ?? [];
  const mainPane = panes.find((pane) => pane.main);
  const fallbackPane = mainPane ? undefined : panes[0]?.sessionId;
  const activePaneId = selectedPane ?? mainPane?.sessionId ?? fallbackPane;

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    const path = `/api/bots/${encodeURIComponent(bot.id)}/terminal`;
    const targetPane = selectedPane ?? fallbackPane;
    try {
      const qs = targetPane ? `?sessionId=${encodeURIComponent(targetPane)}` : "";
      const next = await api(`${path}${qs}`);
      if (request < appliedRequestRef.current) return;
      appliedRequestRef.current = request;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (request < appliedRequestRef.current) return;
      appliedRequestRef.current = request;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (targetPane && /unknown terminal/i.test(message)) {
        setSelectedPane(null);
        // The roster still lists the closed pane, so re-read it or the fallback keeps targeting it.
        try {
          const roster = await api(path);
          if (request < appliedRequestRef.current) return;
          setSnapshot(roster);
          setError(null);
        } catch (retry) {
          if (request < appliedRequestRef.current) return;
          setError(retry instanceof Error ? retry.message : String(retry));
        }
        return;
      }
      setError(message);
    }
  }, [bot.id, selectedPane, fallbackPane]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      appliedRequestRef.current = ++requestRef.current;
    };
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
  const paneLabel = (pane: RemoteTerminalPane) => pane.label ?? (pane.main ? t("terminal.main") : pane.cwd ? folderName(pane.cwd) : pane.sessionId);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset text-ink" aria-label={t("terminal.title")}>
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-panel py-2 pl-11 pr-2 md:pl-5">
        <TerminalSquare size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{t("terminal.title")} <span className="text-ink-secondary">/ {bot.name}</span></h1>
          <p className="truncate font-mono text-[11px] text-ink-secondary">
            {[snapshot?.cwd, noTerminal ? t("terminal.noSession") : snapshot?.exited ? t("terminal.exited", { code: snapshot.exitCode ?? "?" }) : ""].filter(Boolean).join(" · ")}
          </p>
          {panes.length > 1 && (
            <div role="tablist" className="mt-1 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {panes.map((pane) => (
                <button
                  key={pane.sessionId}
                  type="button"
                  role="tab"
                  aria-selected={activePaneId === pane.sessionId}
                  onClick={() => setSelectedPane(pane.main ? null : pane.sessionId)}
                  title={paneLabel(pane)}
                  className={`min-w-[56px] max-w-[160px] shrink-0 truncate rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${
                    activePaneId === pane.sessionId ? "border-accent-text text-ink" : "border-hairline text-ink-secondary hover:text-ink"
                  } ${pane.exited ? "opacity-50" : ""}`}
                >
                  {paneLabel(pane)}
                </button>
              ))}
            </div>
          )}
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
