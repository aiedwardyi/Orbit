import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Presence } from "@/lib/use-presence";
import { ConfirmDialog } from "./ConfirmDialog";

export function StartFreshRow() {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requested = useRef(false);
  if (!window.ogb?.startFresh) return null;

  const token = t("settings.startFresh.typeToken");
  const matches = draft.trim().toLowerCase() === token.toLowerCase();

  const reset = async () => {
    if (!matches || requested.current) return;
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
        onClick={() => {
          setDraft("");
          setConfirming(true);
        }}
        className="rounded-lg border border-danger/40 px-3 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
      >
        {t("settings.startFresh.title")}
      </button>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <Presence open={confirming}>
        {(closing) => (
          <ConfirmDialog
            closing={closing}
            title={t("settings.startFresh.title")}
            body={t("settings.startFresh.confirm")}
            confirmLabel={t("settings.startFresh.title")}
            cancelLabel={t("settings.startFresh.cancel")}
            confirmDisabled={!matches}
            onConfirm={() => void reset()}
            onCancel={() => {
              setDraft("");
              setConfirming(false);
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !matches) return;
                event.preventDefault();
                void reset();
              }}
              aria-label={t("settings.startFresh.typePrompt")}
              placeholder={t("settings.startFresh.typeToken")}
              autoComplete="off"
              spellCheck={false}
              className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </ConfirmDialog>
        )}
      </Presence>
    </div>
  );
}
