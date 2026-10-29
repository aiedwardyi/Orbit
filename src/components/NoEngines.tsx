import { useStore } from "@/state/store";
import { EngineConnect } from "@/components/EngineConnect";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";

export function NoEngines() {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const phone = !window.ogb && isPhone();

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {phone ? t("noEngines.phoneBody") : t("noEngines.body")}
        </p>
        {!phone && <div className="mt-6"><EngineConnect instances={state.instances} onRefresh={() => refreshInstances(true)} /></div>}
      </div>
    </main>
  );
}
