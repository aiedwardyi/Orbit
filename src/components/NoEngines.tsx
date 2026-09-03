// Shown instead of a chat when nothing on this machine can run a bot.
//
// The alternative — which is what used to happen — is a chat that looks
// completely functional until the first message, then fails with a raw spawn
// error. Every engine unavailable is a setup state, not an error state, so it
// gets a screen that says what to do rather than a bot that can't answer.
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/state/store";
import { EngineSetup } from "@/components/EngineSetup";
import { ProviderMark } from "@/components/ProviderIcons";
import { firstLaunchConnectInstances } from "@/lib/engine-rail";
import { useI18n } from "@/lib/i18n";

export function NoEngines() {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const [rechecking, setRechecking] = useState(false);

  // Grok or Claude only. The rest of the fleet is a Settings concern; listing
  // it here turns first launch into a zoo. Box has no installer, so it never
  // belongs on this screen.
  const engines = firstLaunchConnectInstances(state.instances);

  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {t("noEngines.body")}
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {engines.map((instance) => (
            <div key={instance.instanceId} className="rounded-xl border border-hairline/40 bg-card p-3.5">
              <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <ProviderMark driverKind={instance.driverKind} size={16} />
                {instance.displayName}
              </div>
              <EngineSetup instance={instance} intent="cloud" className="mt-0.5" />
            </div>
          ))}
        </div>

        <button
          onClick={recheck}
          disabled={rechecking}
          className="mt-6 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
        >
          {rechecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {rechecking ? t("noEngines.checking") : t("noEngines.checkAgain")}
        </button>
      </div>
    </main>
  );
}
