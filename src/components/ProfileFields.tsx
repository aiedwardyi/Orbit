import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";

/** Name + email. Persist only when Save is pressed. */
export function ProfileFields() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.profile.namePlaceholder")} className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("settings.profile.emailPlaceholder")}
        className={inputClass}
      />
      <button
        type="button"
        onClick={save}
        aria-label={t("settings.profile.saveAria")}
        className="self-start rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control"
      >
        {t("settings.profile.save")}
      </button>
    </div>
  );
}
