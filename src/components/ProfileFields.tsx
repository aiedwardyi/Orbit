import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { useI18n } from "@/lib/i18n";

/** Name + email. Persist only when Save is pressed. */
export function ProfileFields() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.profile.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-wait disabled:opacity-50";
  return (
    <div className="flex flex-col gap-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("settings.profile.namePlaceholder")}
        disabled={saving}
        className={inputClass}
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("settings.profile.emailPlaceholder")}
        disabled={saving}
        className={inputClass}
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        aria-label={t("settings.profile.saveAria")}
        className="self-start rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:cursor-wait disabled:opacity-50"
      >
        {t("settings.profile.save")}
      </button>
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
