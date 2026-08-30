import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Loader2, LockKeyhole, Sparkles, TerminalSquare } from "lucide-react";
import { setEmailGateDone, track } from "@/lib/analytics";
import type { InstanceInfo } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { OrbitMark } from "./OrbitMark";
import { ProviderMark } from "./ProviderIcons";

const CORE_DRIVERS = new Set(["grokAgent", "claudeAgent", "codex", "geminiAgent"]);
const ENGINE_ORDER = ["grokAgent", "claudeAgent", "codex", "antigravityAgent", "geminiAgent"];

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
  const version = instance.snapshot.version?.split(" ")[0];
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-hairline/30 bg-card p-3">
      <ProviderMark driverKind={instance.driverKind} size={17} />
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-ink">
          {instance.displayName}{version ? ` · ${version}` : ""}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">Ready to power a bot.</div>
      </div>
    </div>
  );
}

function SetupRow({ instance }: { instance: InstanceInfo }) {
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
  const [step, setStep] = useState(0);
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  useEffect(() => {
    if (step !== 1) return;
    let active = true;
    let latestRequest = 0;
    const refresh = () => {
      const request = ++latestRequest;
      fetch("/api/instances")
        .then((response) => response.json())
        .then((data) => active && request === latestRequest && setInstances(data.instances ?? []))
        .catch(() => active && request === latestRequest && setInstances([]));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [step]);

  const finish = () => {
    track("onboarding_completed", {
      engines_available: instances?.filter(engineReady).length ?? -1,
    });
    setEmailGateDone("skipped");
    onDone();
  };

  const geminiSubscriptionReady = (instances ?? []).some(
    (instance) => instance.driverKind === "antigravityAgent" && engineReady(instance),
  );
  const engines = (instances ?? [])
    .filter((instance) => {
      if (!instance.install) return false;
      if (instance.driverKind === "geminiAgent" && geminiSubscriptionReady && !engineReady(instance)) return false;
      return engineReady(instance) || CORE_DRIVERS.has(instance.driverKind);
    })
    .sort((a, b) => {
      const aOrder = ENGINE_ORDER.indexOf(a.driverKind);
      const bOrder = ENGINE_ORDER.indexOf(b.driverKind);
      return (aOrder < 0 ? 99 : aOrder) - (bOrder < 0 ? 99 : bOrder);
    });
  const readyEngines = engines.filter(engineReady);
  const setupEngines = engines.filter((instance) => !engineReady(instance));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-6 backdrop-blur-xl">
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/60 ${
          step === 1 ? "max-w-[680px]" : "max-w-[560px]"
        }`}
      >
        {step === 0 ? (
          <div className="flex flex-col items-center px-8 py-9">
            <div className="relative">
              <div className="absolute inset-2 rounded-full bg-accent/20 blur-2xl" />
              <OrbitMark size={82} />
            </div>
            <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">Welcome to Orbit</h1>
            <p className="mt-1.5 max-w-[420px] text-center text-[13.5px] leading-relaxed text-ink-secondary">
              A calm home for the AI tools already on your computer. Pick a model for each teammate, then message it like anyone else.
            </p>
            <div className="mt-6 grid w-full grid-cols-3 gap-2.5">
              <Principle icon={<TerminalSquare size={14} />} title="Your engines" text="Claude, Codex, Gemini, and Grok use existing logins or API keys." />
              <Principle icon={<LockKeyhole size={14} />} title="Local first" text="Chats, files, and preferences stay on this computer." />
              <Principle icon={<Sparkles size={14} />} title="Real teammates" text="Give every bot a role, memory, tools, and routines." />
            </div>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="mt-6 w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.99]"
            >
              Set up Orbit
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col p-7">
            <div className="flex items-center gap-3">
              <OrbitMark size={38} />
              <div>
                <h1 className="text-[18px] font-semibold text-ink">Your engines</h1>
                <p className="mt-0.5 text-[12.5px] text-ink-secondary">Orbit found the AI tools installed on this computer.</p>
              </div>
            </div>
            <div className="mt-5 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {!instances ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
                  <Loader2 size={15} className="animate-spin" /> Checking your computer…
                </div>
              ) : (
                <>
                  {readyEngines.length > 0 && (
                    <section>
                      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Ready</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        {readyEngines.map((instance) => <ReadyTile key={instance.instanceId} instance={instance} />)}
                      </div>
                    </section>
                  )}
                  {setupEngines.length > 0 && (
                    <section className={readyEngines.length ? "mt-2" : ""}>
                      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Optional setup</div>
                      <div className="flex flex-col gap-2.5">
                        {setupEngines.map((instance) => <SetupRow key={instance.instanceId} instance={instance} />)}
                      </div>
                    </section>
                  )}
                  <p className="px-1 pt-1 text-[11px] text-ink-secondary/70">More engines stay available in Settings.</p>
                </>
              )}
            </div>
            <div className="mt-5 flex shrink-0 items-center gap-2.5">
              <button type="button" onClick={() => setStep(0)} className="rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">Back</button>
              <button type="button" onClick={finish} className="flex-1 rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-white hover:brightness-110">Open Orbit</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
