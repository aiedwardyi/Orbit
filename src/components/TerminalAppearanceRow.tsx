import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { applyTerminalMatch, readTerminalMatch } from "@/lib/terminal-appearance";
import { Card } from "./SettingsPrimitives";

export function TerminalAppearanceRow() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(readTerminalMatch);
  const [profile, setProfile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void window.ogb?.terminal?.appearance?.().then((result) => {
      if (alive) { setProfile(result?.profileName ?? null); setLoading(false); }
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  if (window.ogb?.platform !== "win32" || !window.ogb.terminal?.appearance) return null;
  return (
    <Card compact>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div id="terminal-appearance-label" className="text-[13px] font-medium text-ink">{t("terminal.appearance.title")}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            {loading ? t("terminal.appearance.loading") : profile ? t("terminal.appearance.help", { profile }) : t("terminal.appearance.unavailable")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="terminal-appearance-label"
          disabled={loading || (!profile && !enabled)}
          onClick={() => {
            try { applyTerminalMatch(!enabled); setEnabled(!enabled); setError(""); }
            catch { setError(t("terminal.appearance.saveError")); }
          }}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40 ${enabled ? "bg-accent" : "bg-control"}`}
        >
          <span className={`absolute top-0.5 size-5 rounded-full bg-ink transition-transform ${enabled ? "left-0.5 translate-x-4" : "left-0.5"}`} />
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
