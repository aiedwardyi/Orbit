import { useEffect, useState } from "react";

import { api, useOptionalStoreDispatch, useStore, type InstanceInfo } from "@/state/store";
import { EngineMark } from "./EngineMark";
import { EngineSignIn, installCommandFor, installSignsIn, openEngineInstallOrCopy } from "./EngineSetup";
import { isFriendsCliEngine, orderFriendsEngines } from "@/lib/engine-rail";
import { useI18n } from "@/lib/i18n";

export function isEngineConnected(instance: Pick<InstanceInfo, "snapshot">): boolean {
  return instance.snapshot.state === "available" && instance.snapshot.authenticated === true;
}

export function EngineRow({ instance, onConnected, onUpdated }: { instance: InstanceInfo; onConnected?: () => void; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const dispatch = useOptionalStoreDispatch();
  const [current, setCurrent] = useState(instance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [installStatus, setInstallStatus] = useState<"running" | "opened" | "copied" | "failed" | null>(null);
  useEffect(() => { setCurrent(instance); }, [instance]);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/sign-out`, { method: "POST", body: "{}" });
      const { instances } = await api("/api/instances?refresh=1");
      dispatch?.({ type: "instances", instances, preserveRateLimits: true });
      const next = (instances as InstanceInfo[]).find((row) => row.instanceId === instance.instanceId);
      if (next) { setCurrent(next); onUpdated?.(next); }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const canSignOut = Boolean(current.install?.logout) && current.driverKind !== "antigravityAgent";
  const installCommand = current.snapshot.state !== "available" ? installCommandFor(current.install) : null;
  const install = async () => {
    if (!installCommand) return;
    setInstallStatus(null);
    try {
      setInstallStatus(await openEngineInstallOrCopy(current.instanceId, installCommand));
    } catch { setInstallStatus("failed"); }
  };
  return (
    <div data-engine-row={current.instanceId} className="min-w-0 py-2">
      <div className="flex min-h-[44px] items-start gap-2 text-[13px]">
        <span className="mt-2 shrink-0"><EngineMark instance={current} size={16} /></span>
        <span className="flex-1 break-words py-1.5 text-ink">{current.displayName}</span>
        <div className="min-w-0 max-w-[65%] py-1.5 has-[>div>button:first-child]:py-0">
          {current.snapshot.state !== "available" ? (
            <div className="flex flex-wrap items-center justify-end gap-x-3 break-keep text-[12px] text-ink-secondary">
              <span aria-live="polite">{installStatus === "opened" || installStatus === "running" ? t("engine.terminalOpened")
                : installStatus === "copied" ? t("engine.commandCopied")
                  : installStatus === "failed" && !current.install?.docsUrl ? t("engines.installFailed") : t("engines.notInstalled")}</span>
              {installCommand && !(installStatus === "failed" && current.install?.docsUrl) ? <button type="button" onClick={() => void install()}
                className="text-ink hover:underline">{t("engines.install")}</button>
                : current.install?.docsUrl && <a href={current.install.docsUrl} target="_blank" rel="noreferrer"
                className="text-ink hover:underline">{t("engines.install")}</a>}
              {(installStatus === "opened" || installStatus === "running") && (
                <p className="w-full text-right text-[11px] leading-[14px] text-ink-secondary/70">{t(installStatus !== "running" ? "engine.pasteAndEnter" : installSignsIn(current.install) ? "engine.followSignIn" : "engine.installRunning")}</p>
              )}
              {current.install?.needsNode && installCommand?.includes("npm") && (
                <p className="w-full text-right text-[11px] leading-[14px] text-ink-secondary/70">{t("engine.needsNode")}</p>
              )}
            </div>
          ) : isEngineConnected(current) ? (
            <div aria-live="polite" className="flex flex-col items-end gap-1.5 break-keep text-[12px] text-ink-secondary">
              <div className="flex flex-wrap items-center justify-end gap-x-3">
                <span>{t("connections.connected")}</span>
                {canSignOut && <button type="button" onClick={() => void signOut()} disabled={busy}
                  className="text-ink hover:underline disabled:opacity-50">{t("engines.signOut")}</button>}
              </div>
              {error && <span role="alert">{t("engines.didntFinish")}</span>}
            </div>
          ) : (
            <EngineSignIn instance={current} onUpdated={(next) => {
              setCurrent(next);
              if (next.snapshot.authenticated === true) onConnected?.();
            }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function EnginesSettings() {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const [showAll, setShowAll] = useState(false);
  // Same guard as the store's focus probe: a rescan can flash a window that
  // steals focus, so only a real trip away (a terminal sign-in) rescans.
  useEffect(() => {
    const AWAY_MS = 5000;
    let blurredAt = 0;
    let quietUntil = 0;
    const rescan = () => {
      quietUntil = Infinity;
      void refreshInstances(true).finally(() => {
        quietUntil = Date.now() + AWAY_MS;
      });
    };
    const onBlur = () => {
      const now = Date.now();
      blurredAt = now < quietUntil ? 0 : now;
    };
    const onFocus = () => {
      const away = blurredAt > 0 && Date.now() - blurredAt >= AWAY_MS;
      blurredAt = 0;
      if (away) rescan();
    };
    rescan();
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshInstances]);
  const rows = orderFriendsEngines(state.instances.filter(isFriendsCliEngine));
  const installed = rows.filter((row) => row.snapshot.state === "available");
  const missing = rows.filter((row) => row.snapshot.state !== "available");
  return (
    <div className="flex min-w-0 flex-col">
      {rows.length === 0 && <p className="text-[13px] text-ink-secondary">{t("engines.none")}</p>}
      {installed.map((instance) => <EngineRow key={instance.instanceId} instance={instance} />)}
      {missing.length > 0 && <>
        <button type="button" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}
          className="mt-3 self-start py-2 text-[12px] text-ink-secondary underline hover:text-ink">{t("engines.moreEngines")}</button>
        {showAll && <div className="mt-2 flex min-w-0 flex-col">
          {missing.map((instance) => <EngineRow key={instance.instanceId} instance={instance} />)}
        </div>}
      </>}
    </div>
  );
}
