// 2-screen New group wizard: name, then members. Existing bots check off
// in one list; + New bot rows expand inline for described bots. Drafts live
// in component state so a failed create keeps everything.
import { useEffect, useRef, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { api, useStore, type Bot } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { BotPickerList } from "./BotPickerList";
import {
  botNameFromJob,
  groupCreatePayload,
  resolveWizardModel,
  suggestEngine,
  wizardEngineOptions,
  wizardModelOptions,
  type EnginePick,
} from "@/lib/group-wizard";

interface NewRow {
  key: number;
  job: string;
  /** Engine override; null follows the live suggestion. */
  instanceId: string | null;
  model: string | null;
  saving: boolean;
  error: string | null;
}

const PREFERS = [["codex"], ["museAgent"]];
let nextRowKey = 1;

export function GroupWizard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = useStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(() => t("groupWizard.namePrefill"));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<NewRow[]>([]);
  const [addedNew, setAddedNew] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void refreshInstances?.();
  }, [refreshInstances]);

  const bots = state.bots.filter((b) => !b.hidden);

  // Zero bots: lead with the create form instead of an empty list and a
  // hidden + row — nothing to discover, just describe the first bot.
  useEffect(() => {
    if (step === 2 && bots.length === 0) {
      setRows((prev) => (prev.length === 0 ? [{ key: nextRowKey++, job: "", instanceId: null, model: null, saving: false, error: null }] : prev));
    }
  }, [step, bots.length]);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const patchRow = (key: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addBot = async (row: NewRow, pick: EnginePick) => {
    const job = row.job.trim();
    if (!job || row.saving) return;
    patchRow(row.key, { saving: true, error: null });
    try {
      const selection = {
        instanceId: pick.instance.instanceId,
        model: resolveWizardModel(pick.instance, row.model),
      };
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ job, name: botNameFromJob(job), modelSelection: selection }),
      });
      dispatch({ type: "botAdded", bot: result.bot });
      setPicked((prev) => new Set(prev).add(result.bot.id));
      setAddedNew((n) => n + 1);
      setRows((prev) => prev.filter((r) => r.key !== row.key));
    } catch (cause) {
      patchRow(row.key, { saving: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const createGroup = () => {
    const memberIds = [...picked];
    if (memberIds.length < 1 || creating) return;
    setCreating(true);
    setCreateError(null);
    const title = name.trim() || t("groupWizard.namePrefill");
    dispatch({
      type: "createGroup",
      ...groupCreatePayload(title, memberIds),
      onSuccess: () => onClose(),
      onError: () => {
        setCreating(false);
        setCreateError(t("groupWizard.createFailed"));
      },
    });
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (step === 1) onClose();
      else setStep(1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKey}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-wizard-title"
        className="w-[380px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <div id="group-wizard-title" className="text-[15px] font-semibold text-ink">{t("groupWizard.title")}</div>
          <div className="text-[12px] text-ink-secondary">{t("groupWizard.stepOf", { step })}</div>
        </div>

        {step === 1 && (
          <>
            <div className="mb-1 mt-2 text-[14px] font-medium text-ink">{t("groupWizard.nameTitle")}</div>
            <p className="mb-2 text-[12.5px] text-ink-secondary">{t("groupWizard.nameHelper")}</p>
            <input
              autoFocus
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setStep(2);
              }}
              aria-label={t("groupWizard.nameTitle")}
              className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/70"
              >
                {t("groupWizard.cancel")}
              </button>
              <button
                onClick={() => setStep(2)}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
              >
                {t("groupWizard.next")}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="mb-1 mt-2 text-[14px] font-medium text-ink">{t("groupWizard.addBotsTitle")}</div>
            <p className="mb-2 text-[12.5px] text-ink-secondary">{t("groupWizard.membersHelper")}</p>

            <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="" />

            {rows.map((row, rowIndex) => (
              <NewBotRow
                key={row.key}
                row={row}
                preferIndex={addedNew + rowIndex}
                instances={state.instances}
                onPatch={(patch) => patchRow(row.key, patch)}
                onAdd={(pick) => void addBot(row, pick)}
              />
            ))}

            <button
              onClick={() => setRows((prev) => [...prev, { key: nextRowKey++, job: "", instanceId: null, model: null, saving: false, error: null }])}
              className="mt-2 text-[13px] font-medium text-accent hover:brightness-110"
            >
              {rows.length === 0 && addedNew === 0 ? t("groupWizard.newBot") : t("groupWizard.addAnother")}
            </button>

            {createError && <div role="alert" className="mt-2 text-[12.5px] text-danger">{createError}</div>}

            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setStep(1)} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/70">
                {t("groupWizard.back")}
              </button>
              <button
                onClick={createGroup}
                disabled={picked.size < 1 || creating}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
              >
                {picked.size === 1
                  ? t("groupWizard.createGroupOne")
                  : t("groupWizard.createGroupMany", { count: picked.size })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewBotRow({
  row,
  preferIndex,
  instances,
  onPatch,
  onAdd,
}: {
  row: NewRow;
  preferIndex: number;
  instances: ReturnType<typeof useStore>["state"]["instances"];
  onPatch: (patch: Partial<NewRow>) => void;
  onAdd: (pick: EnginePick) => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const jobRef = useRef<HTMLInputElement>(null);
  const [jobInvalid, setJobInvalid] = useState(false);
  const preferKinds = PREFERS[Math.min(preferIndex, PREFERS.length - 1)]!;
  const pick: EnginePick | null = row.instanceId
    ? (() => {
      const instance = instances.find((x) => x.instanceId === row.instanceId) ?? null;
      return instance ? { instance, substituted: false } : null;
    })()
    : (suggestEngine(instances, preferKinds) ?? null);
  const preferKind = preferKinds[0]!;
  const showSubstituted = !!pick?.substituted && instances.some((i) => i.driverKind === preferKind);
  const engineOptions = wizardEngineOptions(instances, pick?.instance ?? null);
  const model = pick ? resolveWizardModel(pick.instance, row.model) : null;
  const jobErrorId = `group-wizard-job-error-${row.key}`;
  const submit = () => {
    if (!row.job.trim()) {
      setJobInvalid(true);
      jobRef.current?.focus();
      return;
    }
    if (pick && !row.saving) onAdd(pick);
  };

  return (
    <div className="mt-2 rounded-lg bg-raised/50 p-2.5">
      <label htmlFor={`group-wizard-job-${row.key}`} className="mb-1 block text-[12.5px] text-ink-secondary">
        {t("groupWizard.jobLabel")}
      </label>
      <input
        ref={jobRef}
        id={`group-wizard-job-${row.key}`}
        autoFocus
        value={row.job}
        maxLength={BOT_PROFILE_LIMITS.description}
        onChange={(e) => {
          setJobInvalid(false);
          onPatch({ job: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("groupWizard.jobPlaceholder")}
        required
        aria-invalid={jobInvalid || undefined}
        aria-describedby={jobInvalid ? jobErrorId : undefined}
        className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
      />
      {jobInvalid && (
        <p id={jobErrorId} role="alert" className="mt-1 text-[12px] text-danger">{t("groupWizard.jobRequired")}</p>
      )}

      {pick ? (
        <div className="mt-1.5">
          <select
            aria-label={t("model.switchEngine")}
            value={pick.instance.instanceId}
            onChange={(e) => onPatch({ instanceId: e.target.value, model: null })}
            className="w-full rounded-lg bg-raised/70 px-2 py-1.5 text-[13px] text-ink"
          >
            {engineOptions.map((i) => (
              <option key={i.instanceId} value={i.instanceId}>{i.displayName}</option>
            ))}
          </select>
          <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <select
              aria-label={t("groupWizard.modelChange")}
              value={model ?? ""}
              onChange={(e) => onPatch({ model: e.target.value, instanceId: pick.instance.instanceId })}
              className="min-w-0 flex-1 rounded-lg bg-raised/70 px-2 py-1.5 text-[13px] text-ink"
            >
              {wizardModelOptions(pick.instance).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={submit}
              disabled={row.saving}
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
            >
              {t("groupWizard.addBot")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-[12.5px] text-ink-secondary">
          <p className="mb-1">{t("groupWizard.noEngine")}</p>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
            className="font-medium text-accent hover:brightness-110"
          >
            {t("groupWizard.connectAi")}
          </button>
        </div>
      )}
      {pick && showSubstituted && (
        <p className="mt-1 text-[12px] text-ink-secondary">
          {t("groupWizard.usingInstead", {
            preferred: preferredLabel(preferKind),
            used: pick.instance.displayName,
          })}
        </p>
      )}
      {row.error && <div role="alert" className="mt-1.5 text-[12.5px] text-danger">{row.error}</div>}
    </div>
  );
}

/** Friendly engine name for the substitution notice; unknown kinds print raw. */
function preferredLabel(kind: string): string {
  if (kind === "geminiAgent") return "Gemini";
  if (kind === "codex") return "Codex";
  if (kind === "museAgent") return "Meta Muse";
  return kind;
}
