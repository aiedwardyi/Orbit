import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert } from "lucide-react";

import { api, useOptionalStoreDispatch, useStore, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { CommandRow, EngineSetup, EngineSignIn } from "./EngineSetup";
import { isFriendsCliEngine, orderFriendsEngines } from "@/lib/engine-rail";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

/** The PATH candidate this engine is actually running, if it appears in
 * `candidates`. An override (`cli`) wins when it is a detected path;
 * otherwise the first PATH hit is what a bare driver default would run.
 * A wrapper / moved binary that is not in the list is not marked. */
export function inUseCliPath(
  instance: { cli?: string; cliDefault?: string },
  candidates: readonly string[],
): string | undefined {
  if (instance.cli) return candidates.includes(instance.cli) ? instance.cli : undefined;
  if (instance.cliDefault && candidates.includes(instance.cliDefault)) return instance.cliDefault;
  return candidates[0];
}

export function isEngineConnected(instance: Pick<InstanceInfo, "snapshot">): boolean {
  return instance.snapshot.state === "available" && instance.snapshot.authenticated === true;
}

/** Value probed and PATCHed: a typed manual path wins over the dropdown. */
export function cliPickerCommitValue(manual: string, selected: string): string {
  return manual.trim() || selected;
}

export function CustomPicker({ instance, cliDefault, onClose, onSaved }: {
  instance: InstanceInfo;
  cliDefault?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // `selected` starts EMPTY, never at instance.cli: a wrapper override
  // ("/ag claude agp") has no matching <option>, and a select whose value
  // points at a missing option renders the placeholder while still holding
  // the ghost value — the form would look empty yet refuse to save.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    // the current override rides the manual input unless it is exactly a
    // detected path (then the dropdown preselects it below)
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);
  const { t } = useI18n();

  // The describe() snapshot can be stale (CLI installed since last refresh);
  // re-fetch candidates once when the picker mounts so the dropdown is current.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        // preselect a detected override in the dropdown; a non-detected one
        // (wrapper string, moved binary) rides the manual input instead
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = cliPickerCommitValue(manual, selected);
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving || resetting;
  const inUse = inUseCliPath(instance, candidates ?? []);
  const currentPath = instance.cli || instance.cliDefault;

  // Editing the path invalidates a previous probe result.
  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value; // freeze: inputs disable during save, but the
    // closure must not see a later keystroke either
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: committed }),
    })
      // onSaved (refreshInstances) failing must NOT read as "not saved" —
      // the PATCH already returned 200. Close regardless; the global banner
      // from refreshInstances already reports the refresh failure.
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        // ok → save immediately; failed → hold for explicit confirmation
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  const reset = () => {
    if (busy || !instance.cli) return;
    setResetting(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e) => setError(e.message))
      .finally(() => setResetting(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {currentPath && (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-mono text-ink-secondary" title={currentPath}>
            {currentPath}
          </span>
          {instance.cli && (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              {resetting ? t("engines.resetting") : t("engines.reset")}
            </button>
          )}
        </div>
      )}
      {candidates !== null && candidates.length > 0 && (
        <div className="relative">
          <select
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={t("engines.detectedAria", { name: instance.displayName })}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          >
            <option value="">{t("engines.selectBinary")}</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p === inUse ? t("engines.inUseSuffix", { cli: p }) : p}</option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
        </div>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return; // nothing to save — same hint the disabled button gives
          save();
        }}
        placeholder={candidates?.length ? t("engines.pathManual") : t("engines.pathPlaceholder")}
        aria-label={t("engines.customAria", { name: instance.displayName })}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("engines.testFailed", { message: probe.message })}
          </span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">{t("engines.testPassed", { version: probe.version })}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex flex-col items-end gap-1.5">
        <p className="max-w-full text-right text-[11.5px] leading-snug text-ink-secondary">
          {t("engines.saveRestartWarning")}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
          >
            {t("createBot.cancel")}
          </button>
          {probe && !probe.ok ? (
            <>
              <button
                onClick={() => setProbe(null)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
              >
                {t("engines.editPath")}
              </button>
              <button
                onClick={() => persist()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-raised/40 disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : t("engines.saveAnyway")}
              </button>
            </>
          ) : (
            <button
              onClick={save}
              disabled={busy || !value || !dirty}
              className={cn(
                "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
                "bg-raised text-ink hover:bg-raised-hover",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("settings.browserProfiles.save")}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EngineRow({ instance, onConnected, onUpdated }: { instance: InstanceInfo; onConnected?: () => void; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const dispatch = useOptionalStoreDispatch();
  const [current, setCurrent] = useState(instance);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCurrent(instance); }, [instance]);
  useEffect(() => { setOpen(false); }, [current.cli]);
  const refresh = async () => {
    const { instances } = await api("/api/instances?refresh=1");
    dispatch?.({ type: "instances", instances, preserveRateLimits: true });
    const next = (instances as InstanceInfo[]).find((row) => row.instanceId === instance.instanceId);
    if (next) { setCurrent(next); onUpdated?.(next); }
  };
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/sign-out`, { method: "POST", body: "{}" });
      await refresh();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <div data-engine-row={current.instanceId} className="min-w-0 py-2">
      {current.snapshot.state !== "available" ? <EngineSetup instance={current} /> : <div className="flex min-h-[44px] items-start gap-2 text-[13px]">
        <span className="mt-2 shrink-0"><ProviderMark driverKind={current.driverKind} size={16} /></span>
        <span className="min-w-0 flex-1 break-words py-1.5 text-ink">{current.displayName}</span>
        <div className="min-w-0 max-w-[65%] py-1.5">
          <EngineSignIn instance={current} onUpdated={(next) => {
            setCurrent(next);
            if (next.snapshot.authenticated === true) onConnected?.();
          }} />
        </div>
      </div>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-1 py-1 text-[12px] text-ink-secondary hover:text-ink">
        <ChevronDown size={12} className={cn(open && "rotate-180")} />{t("engines.details")}
      </button>
      {open && <div className="min-w-0 border-l border-hairline/40 pl-3">
        <CustomPicker instance={current} cliDefault={current.cliDefault} onClose={() => setOpen(false)} onSaved={refresh} />
        {current.install?.logout && current.driverKind !== "antigravityAgent" &&
          <button type="button" onClick={() => void signOut()} disabled={busy}
            className="mt-3 text-[12px] text-ink underline disabled:opacity-50">{t("engines.signOut")}</button>}
        {error && <p role="alert" className="mt-1 text-[12px] text-ink-secondary">{t("engines.didntFinish")}</p>}
        {current.install?.signInCommand && <CommandRow quiet command={current.install.signInCommand}
          signInInstanceId={current.instanceId} actionLabel={t("engines.openInTerminal")} />}
        {current.install?.docsUrl && <a href={current.install.docsUrl} target="_blank" rel="noreferrer"
          className="mt-3 inline-block text-[12px] text-ink underline">{t("engine.viewGuide")}</a>}
      </div>}
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
        {showAll && <div className="mt-2 flex min-w-0 flex-col gap-2">
          {missing.map((instance) => <EngineRow key={instance.instanceId} instance={instance} />)}
        </div>}
      </>}
    </div>
  );
}
