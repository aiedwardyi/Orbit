// Edit an existing room's roster: the same picker "New Room" uses, opened
// from the member mauses in the room header and pre-ticked with who is
// already in. Membership is the only thing this touches — the transcript
// keeps every message a departing bot already sent.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { newBotPayload, resolveWizardModel, type EnginePick } from "@/lib/group-wizard";
import { BotPickerList } from "./BotPickerList";
import { NewBotRow, type NewRow } from "./GroupWizard";
import { nextMemberIds } from "@/lib/room-members";
import { useI18n } from "@/lib/i18n";

export function ManageMembersPanel({
  group,
  onClose,
  triggerRef,
}: {
  group: Group;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rows, setRows] = useState<NewRow[]>([]);
  const [addedNew, setAddedNew] = useState(0);
  const nextRowKey = useRef(1);
  const createdBotIds = useRef(new Set<string>());
  const openedMemberIds = useRef([...group.memberIds]);
  const pendingRowsRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingRows = rows.some((row) => row.saving);

  useEffect(() => {
    pendingRowsRef.current = pendingRows;
  }, [pendingRows]);

  useEffect(() => {
    void refreshInstances?.();
  }, [refreshInstances]);

  // Archived bots stay listed while they are still members — otherwise a
  // room could keep a member you have no way to remove.
  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (element) => !element.hasAttribute("hidden"),
      );
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingRowsRef.current) return;
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [onClose, triggerRef]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    [...bots.map((b) => b.id), ...[...createdBotIds.current].filter((id) => !bots.some((bot) => bot.id === id))],
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, i) => id !== group.memberIds[i]);

  const save = () => {
    if (!memberIds.length) return;
    const opened = openedMemberIds.current;
    const rosterChanged =
      opened.length !== group.memberIds.length || opened.some((id, index) => id !== group.memberIds[index]);
    if (rosterChanged) {
      setSaveError("This group's members changed while the panel was open. Close it and try again.");
      return;
    }
    if (changed) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds } });
    }
    onClose();
  };

  const addCreatedBot = (bot: Bot) => {
    createdBotIds.current.add(bot.id);
    setPicked((prev) => new Set(prev).add(bot.id));
  };

  const patchRow = (key: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

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
        body: JSON.stringify({
          ...newBotPayload(job, selection),
          section: group.section?.trim() || undefined,
        }),
      });
      dispatch({ type: "botAdded", bot: result.bot, activate: false, focusComposer: false });
      addCreatedBot(result.bot);
      setAddedNew((count) => count + 1);
      setRows((prev) => prev.filter((candidate) => candidate.key !== row.key));
    } catch (cause) {
      patchRow(row.key, { saving: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
        onMouseDown={(e) => e.target === e.currentTarget && !pendingRows && onClose()}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("room.manageMembersOf", { name: group.name })}
          className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
        >
          <div className="mb-1 text-[15px] font-semibold text-ink first-letter:uppercase">{t("room.manageMembers")}</div>
          <div className="mb-3 truncate text-[13px] text-ink-secondary">{group.name}</div>
          <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint={t("chrome.createBotFirst")} />
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
            type="button"
            data-manage-create-bot
            onClick={() => {
              const key = nextRowKey.current++;
              setRows((prev) => [
                ...prev,
                { key, job: "", instanceId: null, model: null, saving: false, error: null },
              ]);
            }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/50 px-3 py-2 text-[13px] font-medium text-accent hover:bg-accent/10"
          >
            <Plus size={15} /> {t("room.addBot")}
          </button>
          {!memberIds.length && <div className="mt-2 text-[12px] text-ink-secondary">A group needs at least one bot.</div>}
          {saveError && (
            <div role="alert" className="mt-2 text-[12px] text-danger">
              {saveError}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={onClose}
              disabled={pendingRows}
              className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110 disabled:opacity-40"
            >
              {t("createBot.cancel")}
            </button>
            <button
              onClick={save}
              disabled={!memberIds.length || rows.some((row) => row.saving)}
              className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
            >
              {memberIds.length
                ? t(memberIds.length === 1 ? "room.saveMembersOne" : "room.saveMembersMany", { count: memberIds.length })
                : t("room.save")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
