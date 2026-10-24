import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, FolderOpen } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { WorkingFolderField } from "./WorkingFolderField";
import "./FolderFix.css";

export function FolderFix({ folder, botId, group, onRetry }: {
  folder: string;
  botId?: string;
  group?: Group;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const inFlight = useRef(false);
  const retry = useRef(onRetry);
  retry.current = onRetry;
  // A room turn runs in its task's pin, which can differ from the room's default folder.
  const roomFolder = group && (group.pinnedCwd === undefined ? group.cwd : group.pinnedCwd);
  const target = group && roomFolder === folder ? `/api/groups/${group.id}` : botId ? `/api/bots/${botId}` : null;

  useEffect(() => {
    if (!saved) return;
    const fade = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
    const finishFade = fade ? setTimeout(() => setSettled(true), fade) : undefined;
    const rerun = setTimeout(() => retry.current?.(), fade + 700);
    return () => { clearTimeout(finishFade); clearTimeout(rerun); };
  }, [saved]);

  const save = async (cwd: string) => {
    if (!target) return;
    const result: { bot?: Bot; group?: Group } = await api(target, {
      method: "PATCH", body: JSON.stringify({ cwd }),
    });
    if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
    if (result.group) dispatch({ type: "groupPatched", group: result.group });
    setSettled(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    setSaved(cwd);
  };

  const choose = async () => {
    if (inFlight.current || saved) return;
    if (!window.ogb?.pickFolder) { setEditing(true); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      const parent = folder.replace(/[\\/]+$/, "").match(/^(.*[\\/])[^\\/]+$/)?.[1];
      let chosen: string | null;
      try { chosen = await window.ogb.pickFolder(parent); }
      catch { chosen = await window.ogb.pickFolder(); }
      if (chosen) { setError(null); await save(chosen); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submit = async () => {
    const cwd = draft.trim();
    if (inFlight.current || saved || !cwd) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try { await save(cwd); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <div className="flex justify-start">
      <div data-folder-fix={saved ? settled ? "success" : "fading" : "red"} className="folder-fix grid min-w-0 max-w-[min(42rem,78%)]">
        {!settled && (
          <div className="folder-fix-error col-start-1 row-start-1 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
            <div className="flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{t("chat.folderMissing", { folder })}</span>
            </div>
            {onRetry && target && (
              editing ? <WorkingFolderField value={draft} onChange={setDraft} onSave={() => void submit()} disabled={busy || !draft.trim()} /> : (
                <button onClick={() => void choose()} disabled={busy || Boolean(saved)} className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15 disabled:opacity-50">
                  <FolderOpen size={12} /> {t("chat.chooseFolder")}
                </button>
              )
            )}
            {error && <div role="alert" className="mt-2 text-[12px]">{error}</div>}
          </div>
        )}
        {saved && (
          <div role="status" className="folder-fix-success col-start-1 row-start-1 flex min-w-0 self-start items-center gap-2 py-1.5 text-[13px] text-ink-secondary" title={saved}>
            <Check size={15} className="shrink-0 text-success" />
            <span className="min-w-0 truncate" title={saved}>{t("chat.folderSet", { folder: saved.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || saved })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
