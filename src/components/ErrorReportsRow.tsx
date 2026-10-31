import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function ErrorReportsRow() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let gone = false;
    void window.ogb?.errorReportConsent?.().then((value) => {
      if (!gone) { setEnabled(value); setReady(true); }
    }).catch(() => {});
    return () => { gone = true; };
  }, []);
  if (!window.ogb?.setErrorReportConsent || enabled === null) return null;
  const toggle = async () => {
    if (saving || !ready) return;
    setSaving(true);
    try { setEnabled(await window.ogb!.setErrorReportConsent!(!enabled)); }
    catch {} finally { setSaving(false); }
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{t("settings.errorReports.title")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.errorReports.help")}</div>
        </div>
        <button type="button" role="switch" aria-label={t("settings.errorReports.title")} aria-checked={enabled}
          disabled={!ready || saving} onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-control"} disabled:opacity-50`}>
          <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${enabled ? "left-[21px]" : "left-[3px]"}`} />
        </button>
      </div>
    </Card>
  );
}
