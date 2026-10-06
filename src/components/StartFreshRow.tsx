import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export function StartFreshRow() {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requested = useRef(false);
  if (!window.ogb?.startFresh) return null;

  const reset = async () => {
    if (requested.current) return;
    requested.current = true;
    setSaving(true);
    setConfirming(false);
    setError("");
    try {
      await window.ogb!.startFresh!();
    } catch {
      requested.current = false;
      setSaving(false);
      setError(t("settings.startFresh.error"));
    }
  };

  return (
    <div className="mt-4 border-t border-danger/25 pt-4">
      <button
        type="button"
        disabled={saving}
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-danger/40 px-3 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
      >
        {t("settings.startFresh.title")}
      </button>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      {confirming && (
        <ConfirmDialog
          title={t("settings.startFresh.title")}
          body={t("settings.startFresh.confirm")}
          confirmLabel={t("settings.startFresh.title")}
          cancelLabel={t("settings.startFresh.cancel")}
          onConfirm={() => void reset()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
