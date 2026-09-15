// 3-screen New group wizard: name, first bot, second bot. One decision per
// screen; drafts live in component state so a failed create keeps them.
import { useEffect, useMemo, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { api, useStore, type Bot } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { BotPickerList } from "./BotPickerList";
import {
  botChoicesForStep,
  botNameFromJob,
  groupCreatePayload,
  suggestEngine,
  type EnginePick,
} from "@/lib/group-wizard";

interface BotSlot {
  existingId: string | null;
  job: string;
  createdId: string | null;
  instanceId: string | null;
  model: string | null;
  saving: boolean;
  error: string | null;
  showModels: boolean;
}

const emptySlot = (): BotSlot => ({
  existingId: null,
  job: "",
  createdId: null,
  instanceId: null,
  model: null,
  saving: false,
  error: null,
  showModels: false,
});

const PREFERS = [["geminiAgent"], ["codex"]];

/** Friendly engine name for the substitution notice; unknown kinds print raw. */
function preferredLabel(kind: string): string {
  if (kind === "geminiAgent") return "Gemini";
  if (kind === "codex") return "Codex";
  return kind;
}

export function GroupWizard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = useStore();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState(() => t("groupWizard.namePrefill"));
  const [slots, setSlots] = useState<BotSlot[]>([emptySlot(), emptySlot()]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void refreshInstances?.();
  }, [refreshInstances]);

  const bots = useMemo(() => state.bots.filter((b) => !b.hidden), [state.bots]);
  const picks: (EnginePick | null)[] = useMemo(
    () =>
      slots.map((slot, i) => {
        if (slot.instanceId) {
          const instance = state.instances.find((x) => x.instanceId === slot.instanceId) ?? null;
          return instance ? { instance, substituted: false } : null;
        }
        return suggestEngine(state.instances, PREFERS[i]!);
      }),
    [slots, state.instances],
  );

  const setSlot = (index: number, patch: Partial<BotSlot>) =>
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const slotBotId = (slot: BotSlot) => slot.existingId ?? slot.createdId;

  const addBot = async (index: number) => {
    const slot = slots[index]!;
    const pick = picks[index];
    const job = slot.job.trim();
    if (!job || !pick || slot.saving) return;
    setSlot(index, { saving: true, error: null });
    try {
      const selection = { instanceId: pick.instance.instanceId, model: slot.model ?? pick.instance.models.default };
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ job, name: botNameFromJob(job), modelSelection: selection }),
      });
      dispatch({ type: "botAdded", bot: result.bot });
      setSlot(index, { createdId: result.bot.id, saving: false });
    } catch (cause) {
      setSlot(index, { saving: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const createGroup = () => {
    const memberIds = slots.map(slotBotId).filter((id): id is string => id !== null);
    if (memberIds.length < 2 || creating) return;
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
      else setStep((s) => (s === 3 ? 2 : 1));
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

        {(step === 2 || step === 3) && (
          <BotStep
            index={step - 2}
            slot={slots[step - 2]!}
            pick={picks[step - 2] ?? null}
            preferKind={PREFERS[step - 2]![0]!}
            choices={botChoicesForStep(bots, step === 3 ? slotBotId(slots[0]!) : null)}
            creatingGroup={creating}
            createError={createError}
            isLast={step === 3}
            onPatch={(patch) => setSlot(step - 2, patch)}
            onBack={() => setStep(step === 3 ? 2 : 1)}
            onAdd={() => void addBot(step - 2)}
            onUse={() => (step === 3 ? createGroup() : setStep(3))}
            onCreate={createGroup}
          />
        )}
      </div>
    </div>
  );
}

function BotStep({
  index,
  slot,
  pick,
  preferKind,
  choices,
  creatingGroup,
  createError,
  isLast,
  onPatch,
  onBack,
  onAdd,
  onUse,
  onCreate,
}: {
  index: number;
  slot: BotSlot;
  pick: EnginePick | null;
  preferKind: string;
  choices: Bot[];
  creatingGroup: boolean;
  createError: string | null;
  isLast: boolean;
  onPatch: (patch: Partial<BotSlot>) => void;
  onBack: () => void;
  onAdd: () => void;
  onUse: () => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const doneId = slot.existingId ?? slot.createdId;
  const modelLabel = pick
    ? (pick.instance.models.options.find((o) => o.id === (slot.model ?? pick.instance.models.default))?.label ??
      (slot.model ?? pick.instance.models.default))
    : null;
  const showSubstituted =
    pick?.substituted && preferKind !== pick.instance.driverKind;

  return (
    <>
      <div className="mb-1 mt-2 text-[14px] font-medium text-ink">
        {isLast ? t("groupWizard.addSecondTitle") : t("groupWizard.addFirstTitle")}
      </div>
      <p className="mb-2 text-[12.5px] text-ink-secondary">
        {isLast ? t("groupWizard.secondHelper") : t("groupWizard.botHelper")}
      </p>

      {choices.length > 0 && !slot.createdId && (
        <BotPickerList
          bots={choices}
          picked={new Set(slot.existingId ? [slot.existingId] : [])}
          onToggle={(id) => onPatch({ existingId: slot.existingId === id ? null : id, job: "" })}
          emptyHint=""
        />
      )}

      {!doneId && (
        <div className="mt-2">
          <label htmlFor={`group-wizard-job-${index}`} className="mb-1 block text-[12.5px] text-ink-secondary">
            {t("groupWizard.jobLabel")}
          </label>
          <input
            id={`group-wizard-job-${index}`}
            autoFocus={choices.length === 0}
            value={slot.job}
            maxLength={BOT_PROFILE_LIMITS.description}
            onChange={(e) => onPatch({ job: e.target.value, existingId: null })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAdd();
            }}
            placeholder={t("groupWizard.jobPlaceholder")}
            className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      )}

      {!doneId && pick && (
        <div className="mt-2 text-[12.5px] text-ink-secondary">
          {t("groupWizard.modelLabel", { model: modelLabel ?? pick.instance.displayName })}
          {" · "}
          <button onClick={() => onPatch({ showModels: !slot.showModels })} className="underline hover:text-ink">
            {t("groupWizard.modelChange")}
          </button>
          {slot.showModels && (
            <select
              aria-label={t("groupWizard.modelChange")}
              value={slot.model ?? pick.instance.models.default}
              onChange={(e) => onPatch({ model: e.target.value })}
              className="mt-1 w-full rounded-lg bg-raised/70 px-2 py-1.5 text-[13px] text-ink"
            >
              {pick.instance.models.options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          )}
        </div>
      )}
      {!doneId && pick && showSubstituted && (
        <p className="mt-1 text-[12px] text-ink-secondary">
          {t("groupWizard.usingInstead", {
            preferred: preferredLabel(preferKind),
            used: pick.instance.displayName,
          })}
        </p>
      )}
      {!doneId && !pick && (
        <div className="mt-2 rounded-lg bg-raised/50 px-3 py-2.5 text-[12.5px] text-ink-secondary">
          <p className="mb-1.5">{t("groupWizard.noEngine")}</p>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
            className="font-medium text-accent hover:brightness-110"
          >
            {t("groupWizard.connectAi")}
          </button>
        </div>
      )}

      {slot.error && <div role="alert" className="mt-2 text-[12.5px] text-danger">{slot.error}</div>}
      {isLast && createError && <div role="alert" className="mt-2 text-[12.5px] text-danger">{createError}</div>}

      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onBack} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/70">
          {t("groupWizard.back")}
        </button>
        {doneId ? (
          <button
            onClick={isLast ? onCreate : onUse}
            disabled={isLast && creatingGroup}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
          >
            {isLast ? t("groupWizard.createGroup") : t("groupWizard.useThisBot")}
          </button>
        ) : slot.existingId ? (
          <button
            onClick={onUse}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
          >
            {t("groupWizard.useThisBot")}
          </button>
        ) : (
          <button
            onClick={onAdd}
            disabled={!slot.job.trim() || !pick || slot.saving}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
          >
            {t("groupWizard.addBot")}
          </button>
        )}
      </div>
    </>
  );
}
