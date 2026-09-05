// App-language control. English and Korean are first-class; "Match this
// computer" keeps following the OS until the person picks one explicitly.
import { useI18n, type LocalePreference } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";

const OPTIONS: LocalePreference[] = ["system", "en", "ko"];

export function LanguagePicker() {
  const { t, preference, setPreference } = useI18n();
  const hintId = "language-match-system-hint";
  return (
    <Card title={t("language.title")} compact>
      <div role="radiogroup" aria-label={t("language.title")} className="flex gap-1 rounded-lg bg-inset p-0.5">
        {OPTIONS.map((id) => {
          const selected = preference === id;
          const label =
            id === "system" ? t("language.matchSystem") : id === "en" ? t("language.name.en") : t("language.name.ko");
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={id === "system" ? hintId : undefined}
              onClick={() => setPreference(id)}
              className={cn(
                "min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[13px] font-medium transition-colors",
                selected ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p id={hintId} className="mt-1.5 text-[12px] leading-snug text-ink-secondary">
        {t("language.matchSystemHint")}
      </p>
    </Card>
  );
}
