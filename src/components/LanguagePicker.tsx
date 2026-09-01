// App-language control. English and Korean are first-class; "Match this
// computer" keeps following the OS until the person picks one explicitly.
import { useI18n, type LocalePreference } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";

const OPTIONS: LocalePreference[] = ["system", "en", "ko"];

export function LanguagePicker() {
  const { t, preference, setPreference } = useI18n();
  return (
    <Card title={t("language.title")} subtitle={t("language.subtitle")}>
      <div role="radiogroup" aria-label={t("language.title")} className="flex flex-col gap-2">
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
              onClick={() => setPreference(id)}
              className={cn(
                "rounded-lg border px-3 py-2 text-left text-[14px] transition-colors",
                selected ? "border-accent bg-accent/10 text-ink" : "border-hairline/40 text-ink hover:bg-control",
              )}
            >
              <span className="font-medium">{label}</span>
              {id === "system" ? (
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-secondary">
                  {t("language.matchSystemHint")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
