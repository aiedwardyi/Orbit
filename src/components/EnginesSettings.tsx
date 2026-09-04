// Engines settings — per-instance CLI path override. One "Set CLI…" button
// per engine reveals a picker: a "detected" dropdown of every binary the
// server found on PATH, plus a manual path input. Saving first probes the
// binary (`<cli> --version`, same PATH a real turn uses); a failed probe
// asks before registering — the classic miss is a path the terminal sees
// but this GUI app can't.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { ProviderMark } from "./ProviderIcons";
import { isFriendsCliEngine, splitEngineRail, splitFriendsEngines } from "@/lib/engine-rail";
import { showEngineRailZoo } from "@/lib/friends-chrome";
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
  const busy = probing || saving;
  const inUse = inUseCliPath(instance, candidates ?? []);

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

  return (
    <div className="mt-2.5 flex flex-col gap-2">
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
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
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
  );
}

function EngineRow({ instance }: { instance: InstanceInfo }) {
  const { t } = useI18n();
  const { refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  // Close the picker when this instance's override changes to anything else
  // — a save from this row, another tab, or the 5-min refresh. The picker
  // initialized its fields from the OLD value and never re-syncs, so staying
  // open would show stale state.
  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const reset = () => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      // The reset already succeeded once PATCH returns 200. A follow-up list
      // refresh failure should not tell the user the reset itself failed.
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px]">
        <span className={cn("size-1.5 shrink-0 rounded-full", instance.cli ? "bg-accent" : "bg-raised-hover")} />
        <ProviderMark driverKind={instance.driverKind} size={14} />
        <span className="shrink-0 text-ink">{instance.displayName}</span>
        {instance.cli ? (
          <span className="truncate font-mono text-[11.5px] text-accent" title={instance.cli}>
            {instance.cli}
          </span>
        ) : (
          instance.cliDefault && (
            <span className="truncate text-[11px] text-ink-secondary">{t("engines.defaultSuffix", { cli: instance.cliDefault })}</span>
          )
        )}
        <span className="flex-1" />
        {instance.cli && (
          <button
            onClick={reset}
            disabled={switching}
            className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:opacity-50"
          >
            {switching ? t("engines.resetting") : t("engines.reset")}
          </button>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px]",
            open ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
          )}
        >
          {t("engines.setCli")}
        </button>
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {open && (
        <CustomPicker
          instance={instance}
          cliDefault={instance.cliDefault}
          onClose={() => setOpen(false)}
          onSaved={refreshInstances}
        />
      )}
    </div>
  );
}

export function EnginesSettings() {
  const { t } = useI18n();
  const { state } = useStore();
  const [showAll, setShowAll] = useState(false);
  // every KNOWN-driver instance has cliDefault; unknown-driver shadows have
  // neither unless an override was set. Including them keeps a Reset-able row
  // (and a Set CLI… path) for engines the running build doesn't recognize.
  const rows = state.instances.filter((i) => i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state === "unavailable");
  const cliRows = rows.filter(isFriendsCliEngine);
  const { friends, rest } = splitFriendsEngines(rows);
  const zoo = showEngineRailZoo();
  // Folding away every row would leave a lone toggle, so only fold when a
  // friends engine stays on screen.
  const collapsible = zoo && friends.length > 0 && rest.length > 0;
  const visible = zoo && collapsible && !showAll ? friends.filter(isFriendsCliEngine) : zoo && showAll ? rows : cliRows;

  return (
    <div className="flex flex-col gap-5">
      {rows.length === 0 && (
        <div className="text-[13px] text-ink-secondary">{t("engines.none")}</div>
      )}
      {(() => {
        const { subscription, custom } = splitEngineRail(visible);
        return (
          <>
            {subscription.length > 0 && <EngineGroupLabel>{t("engines.models")}</EngineGroupLabel>}
            {subscription.map((i) => (
              <EngineRow key={i.instanceId} instance={i} />
            ))}
            {custom.length > 0 && <EngineGroupLabel className="pt-1">{t("noEngines.local")}</EngineGroupLabel>}
            {custom.map((i) => (
              <EngineRow key={i.instanceId} instance={i} />
            ))}
          </>
        );
      })()}
      {collapsible && (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
          aria-expanded={showAll}
          className="self-start rounded-lg text-[12px] text-ink-secondary hover:text-ink"
        >
          {showAll ? t("engines.showFewer") : t("engines.showAll", { count: rest.length })}
        </button>
      )}
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        {t("engines.help")}
      </div>
    </div>
  );
}
