import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Loader2, LockKeyhole, Sparkles, TerminalSquare } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { isRetiredEngineKind } from "../../shared/model-selection.ts";
import { EngineSetup } from "./EngineSetup";
import { EngineRow } from "./EnginesSettings";
import { OrbitMark } from "./OrbitMark";
import { isEmptyEngineLaunch, isFriendsCliEngine } from "@/lib/engine-rail";
import { EngineConnect } from "./EngineConnect";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { ProviderMark } from "./ProviderIcons";

const CORE_DRIVERS = new Set(["grokAgent", "claudeAgent", "codex"]);
// Leads with the DEFAULT_FLEET order like the rail does.
const ENGINE_ORDER = ["claudeAgent", "codex", "grokAgent", "antigravityAgent"];

function StatusRow({
  ok,
  title,
  mark,
  children,
}: {
  ok: boolean;
  title: string;
  mark: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-hairline/30 bg-card p-3.5">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
        }`}
      >
        {ok ? <Check size={14} /> : <AlertTriangle size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          {mark}
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function engineReady(instance: InstanceInfo): boolean {
  return (
    instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false)
  );
}

function ReadyTile({ instance }: { instance: InstanceInfo }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-hairline/30 bg-card p-3">
      <ProviderMark driverKind={instance.driverKind} size={17} />
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-ink">
          {instance.displayName}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{t("onboarding.engineReady")}</div>
      </div>
    </div>
  );
}

function SetupRow({ instance, onConnected }: { instance: InstanceInfo; onConnected: () => void }) {
  if (instance.snapshot.state === "available" && isFriendsCliEngine(instance)) return <EngineRow instance={instance} onConnected={onConnected} />;
  return (
    <StatusRow
      ok={false}
      title={instance.displayName}
      mark={<ProviderMark driverKind={instance.driverKind} size={16} />}
    >
      <EngineSetup
        instance={instance}
        className="mt-2.5"
        intent={instance.access === "custom" ? "inject" : "cloud"}
      />
    </StatusRow>
  );
}

function Principle({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-hairline/30 bg-card p-3.5 text-left">
      <span className="flex size-7 items-center justify-center rounded-lg bg-control text-ink-secondary">{icon}</span>
      <div className="mt-2.5 text-[13px] font-semibold text-ink">{title}</div>
      <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{text}</div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [connectSession, setConnectSession] = useState(false);
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const refreshInstancesRef = useRef<() => Promise<void>>(async () => {});
  const dialogRef = useRef<HTMLDivElement>(null);
  // A phone opens a PC that is already set up, so it only ever needs the sign-in.
  const phone = !window.ogb && isPhone();

  useEffect(() => {
    let active = true;
    let pending: Promise<void> | undefined;
    const refresh = (probe: boolean) => {
      if (pending) return pending;
      setInstancesError(null);
      pending = fetch(probe ? "/api/instances?refresh=1" : "/api/instances")
        .then((response) => {
          // A phone without this PC's cookie, not a broken engine check.
          if (response.status === 401) return null;
          if (!response.ok) throw new Error(`engine check failed with ${response.status}`);
          return response.json();
        })
        .then((data) => {
          if (!active) return;
          if (data && phone) return onDone();
          setSignedOut(!data);
          if (data) setInstances(data.instances ?? []);
        })
        .catch(() => {
          if (active) {
            setSignedOut(false);
            setInstancesError(t("onboarding.enginesError"));
          }
        }).finally(() => { pending = undefined; });
      return pending;
    };
    refreshInstancesRef.current = () => refresh(true);
    void refresh(false);
    const onFocus = () => { void refresh(true); };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    controls()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = controls();
      if (!focusable.length) return event.preventDefault();
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [step, instances, instancesError, signedOut]);

  if (phone && !signedOut && !instancesError) return null;

  const emptyConnect = connectSession || instances !== null && isEmptyEngineLaunch(instances);

  const retryInstances = () => {
    // Keep setup visible while an install probe runs.
    if (!emptyConnect) setInstances(null);
    setInstancesError(null);
    return refreshInstancesRef.current();
  };

  const finish = () => {
    onDone();
  };

  const live = (instances ?? []).filter((instance) => !isRetiredEngineKind(instance.driverKind));
  const engines = live
    .filter((instance) => {
      if (!instance.install) return false;
      return engineReady(instance) || CORE_DRIVERS.has(instance.driverKind) || (isFriendsCliEngine(instance) && instance.snapshot.state === "available");
    })
    .sort((a, b) => {
      const aOrder = ENGINE_ORDER.indexOf(a.driverKind);
      const bOrder = ENGINE_ORDER.indexOf(b.driverKind);
      return (aOrder < 0 ? 99 : aOrder) - (bOrder < 0 ? 99 : bOrder);
    });
  const readyEngines = engines.filter(engineReady);
  const setupEngines = engines.filter((instance) => !engineReady(instance));
  const hasReadyEngine = live.some(engineReady);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-6 backdrop-blur-xl">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/60 ${
          step === 1 ? "max-w-[680px]" : "max-w-[560px]"
        }`}
      >
        {signedOut ? (
          <div className="flex flex-col items-center px-8 py-9">
            <OrbitMark size={56} />
            <h1 id="onboarding-title" className="mt-5 text-[20px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.signInTitle")}</h1>
            <p className="mt-1.5 max-w-[420px] break-keep text-center text-[13.5px] leading-relaxed text-ink-secondary">
              {t("onboarding.signInBody")}
            </p>
            <button
              type="button"
              onClick={retryInstances}
              className="mt-6 w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99]"
            >
              {t("onboarding.tryAgain")}
            </button>
          </div>
        ) : step === 0 ? (
          <div className="flex flex-col items-center px-8 py-9">
            <div className="relative">
              <div className="absolute inset-2 rounded-full bg-accent/20 blur-2xl" />
              <OrbitMark size={82} />
            </div>
            <h1 id="onboarding-title" className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.welcomeTitle")}</h1>
            <p className="mt-1.5 max-w-[420px] text-center text-[13.5px] leading-relaxed text-ink-secondary">
              {t("onboarding.welcomeBody")}
            </p>
            <div className="mt-6 grid w-full grid-cols-3 gap-2.5">
              <Principle icon={<TerminalSquare size={14} />} title={t("onboarding.principle.engines.title")} text={t("onboarding.principle.engines.text")} />
              <Principle icon={<LockKeyhole size={14} />} title={t("onboarding.principle.local.title")} text={t("onboarding.principle.local.text")} />
              <Principle icon={<Sparkles size={14} />} title={t("onboarding.principle.teammates.title")} text={t("onboarding.principle.teammates.text")} />
            </div>
            {instancesError && (
              <div role="alert" className="mt-4 w-full rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                {instancesError} {t("onboarding.enginesErrorHint")}
              </div>
            )}
            <button
              type="button"
              disabled={!instances && !instancesError}
              onClick={() => {
                if (instancesError) return retryInstances();
                if (hasReadyEngine) return finish();
                setConnectSession(emptyConnect);
                setStep(1);
              }}
              className={`${instancesError ? "mt-3" : "mt-6"} w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {instancesError ? t("onboarding.tryAgain") : !instances ? t("onboarding.checking") : emptyConnect ? t("noEngines.title") : t("onboarding.continue")}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col p-7">
            <div className="flex items-center gap-3">
              <OrbitMark size={38} />
              <div>
                <h1 id="onboarding-title" className="text-[18px] font-semibold text-ink">{emptyConnect ? t("noEngines.title") : t("onboarding.enginesTitle")}</h1>
                <p className="mt-0.5 text-[12.5px] text-ink-secondary">{emptyConnect ? t("noEngines.body") : t("onboarding.enginesFound")}</p>
              </div>
            </div>
            {emptyConnect && instances ? <div className="mt-5 flex min-h-0 flex-col">
              <EngineConnect instances={instances} onRefresh={retryInstances} recheckOnFocus={false} footer={{ back: () => { setConnectSession(false); setStep(0); }, open: finish }} />
            </div> : <>
            <div className="mt-5 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {instancesError ? (
                <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                  {instancesError} {t("onboarding.enginesErrorHint")}
                </div>
              ) : !instances ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
                  <Loader2 size={15} className="animate-spin" /> {t("onboarding.checking")}
                </div>
              ) : (
                <>
                  {readyEngines.length > 0 && (
                    <section>
                      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{t("onboarding.ready")}</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        {readyEngines.map((instance) => isFriendsCliEngine(instance)
                          ? <EngineRow key={instance.instanceId} instance={instance} onUpdated={(next) => {
                            setInstances((rows) => rows?.map((row) => row.instanceId === next.instanceId ? next : row) ?? null);
                          }} />
                          : <ReadyTile key={instance.instanceId} instance={instance} />)}
                      </div>
                    </section>
                  )}
                  {setupEngines.length > 0 && (
                    <section className={readyEngines.length ? "mt-2" : ""}>
                      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{t("onboarding.optionalSetup")}</div>
                      <div className="flex flex-col gap-2.5">
                        {setupEngines.map((instance) => <SetupRow key={instance.instanceId} instance={instance} onConnected={retryInstances} />)}
                      </div>
                    </section>
                  )}
                  <p className="px-1 pt-1 text-[11px] text-ink-secondary/70">{t("onboarding.moreInSettings")}</p>
                </>
              )}
            </div>
            <div className="mt-5 flex shrink-0 items-center gap-2.5">
              <button type="button" onClick={() => setStep(0)} className="rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("onboarding.back")}</button>
              <button type="button" onClick={instancesError ? retryInstances : finish} disabled={!instancesError && !hasReadyEngine} className="flex-1 rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{instancesError ? t("onboarding.tryAgain") : t("onboarding.openOrbit")}</button>
            </div>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
