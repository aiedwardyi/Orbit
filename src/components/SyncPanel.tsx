import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Cloud, Download, FolderOpen, RefreshCw, Unlink, Upload } from "lucide-react";

import { api } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

type SyncStatus = {
  configured: boolean;
  folder: string | null;
  status: "disconnected" | "waiting" | "up-to-date" | "needs-review";
  operations: number;
  invalidFiles: string[];
  conflicts: number;
  lastSyncAt: number | null;
  syncChats: boolean;
};

type Preview = {
  bots: Array<{ id: string; name: string; action: "add" | "update" | "archive" }>;
  conflicts: Array<{
    id: string;
    field: string;
    chosenOperationId: string;
    variants: Array<{ value: unknown; operationId: string }>;
  }>;
  invalidFiles: string[];
  operations: number;
  revision: string;
  localRevision: string;
};

function folderName(folder: string | null): string {
  if (!folder) return "";
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

function statusLabel(status: SyncStatus["status"], t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "up-to-date") return t("settings.sync.upToDate");
  if (status === "waiting") return t("settings.sync.waiting");
  if (status === "needs-review") return t("settings.sync.needsReview");
  return t("settings.sync.disconnected");
}

export function SyncPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"choose" | "publish" | "preview" | "import" | "disconnect" | "chats" | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setStatus((await api("/api/profile-sync")) as SyncStatus);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sync.saveError"));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const chooseFolder = async () => {
    const picked = await window.ogb?.pickFolder?.(status?.folder ?? undefined);
    if (!picked || busy) return;
    setBusy("choose");
    setError("");
    try {
      setStatus((await api("/api/profile-sync", { method: "PUT", body: JSON.stringify({ folder: picked }) })) as SyncStatus);
      setPreview(null);
      setConflictChoices({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sync.saveError"));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    try {
      setStatus((await api("/api/profile-sync", { method: "DELETE" })) as SyncStatus);
      setPreview(null);
      setConflictChoices({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sync.saveError"));
    } finally {
      setBusy(null);
    }
  };

  const toggleChats = async () => {
    if (busy || !status?.configured) return;
    setBusy("chats");
    setError("");
    try {
      setStatus((await api("/api/profile-sync/chats", { method: "PUT", body: JSON.stringify({ enabled: !status.syncChats }) })) as SyncStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sync.saveError"));
    } finally {
      setBusy(null);
    }
  };

  const action = async (kind: "publish" | "preview" | "import") => {
    if (busy || !status?.configured) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "preview") {
        const next = (await api("/api/profile-sync/preview")) as Preview;
        setPreview(next);
        setConflictChoices({});
      } else if (kind === "publish") {
        const result = await api("/api/profile-sync/publish", { method: "POST" });
        setStatus(result.status as SyncStatus);
      } else {
        if (!preview) return;
        const result = await api("/api/profile-sync/import", {
          method: "POST",
          body: JSON.stringify({
            confirm: true,
            previewRevision: preview.revision,
            localRevision: preview.localRevision,
            resolutions: conflictChoices,
          }),
        });
        setStatus(result.status as SyncStatus);
        setPreview(null);
        setConflictChoices({});
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sync.saveError"));
    } finally {
      setBusy(null);
    }
  };

  const state = status ?? {
    configured: false,
    folder: null,
    status: "disconnected" as const,
    operations: 0,
    invalidFiles: [],
    conflicts: 0,
    lastSyncAt: null,
    syncChats: false,
  };
  const busyLabel = useMemo(() => busy === "preview" ? t("settings.sync.preview") : busy === "import" ? t("settings.sync.import") : "", [busy, t]);
  const conflictsResolved = Boolean(preview) && preview!.conflicts.every((conflict) => Boolean(conflictChoices[conflict.id]));

  return (
    <Card title={t("settings.sync.title")} subtitle={t("settings.sync.subtitle")}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5">
          <Cloud size={16} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">{statusLabel(state.status, t)}</div>
            {state.folder ? <div className="truncate font-mono text-[11px] text-ink-secondary" title={state.folder}>{folderName(state.folder)}</div> : null}
          </div>
          <button type="button" onClick={() => void refresh()} disabled={busy !== null} aria-label="Refresh sync status" className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
            <RefreshCw size={14} className={busy ? "animate-spin" : undefined} />
          </button>
        </div>

        <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.sync.folderHelp")}</p>
        {!status || state.syncChats ? null : <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.sync.localChats")}</p>}

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{t("settings.sync.chats")}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.sync.chatsHelp")}</div>
          </div>
          <button
            role="switch"
            aria-checked={state.syncChats}
            aria-label={t("settings.sync.chats")}
            disabled={busy !== null || !state.configured}
            onClick={() => void toggleChats()}
            className={`${cnSwitch(state.syncChats)} disabled:opacity-40${status ? "" : " invisible"}`}
          >
            <span className={cnKnob(state.syncChats)} />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void chooseFolder()} disabled={busy !== null || !window.ogb?.pickFolder} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40">
            <FolderOpen size={14} />{state.configured ? t("settings.sync.changeFolder") : t("settings.sync.chooseFolder")}
          </button>
          {state.configured ? <button type="button" onClick={() => void disconnect()} disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"><Unlink size={14} />{t("settings.sync.disconnect")}</button> : null}
        </div>

        {state.configured ? (
          <div className="flex flex-wrap gap-2 border-t border-hairline/30 pt-3">
            <button type="button" onClick={() => void action("publish")} disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"><Upload size={14} />{t("settings.sync.publish")}</button>
            <button type="button" onClick={() => void action("preview")} disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"><Download size={14} />{busyLabel || t("settings.sync.preview")}</button>
          </div>
        ) : null}

        {preview ? (
          <div className="rounded-lg border border-hairline/40 bg-inset p-3">
            <div className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.sync.previewHelp")}</div>
            {preview.operations === 0 ? <div className="mt-2 text-[12px] text-ink-secondary">{t("settings.sync.previewEmpty")}</div> : preview.bots.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {preview.bots.slice(0, 30).map((bot) => <div key={bot.id} className="flex items-center justify-between gap-2 text-[12px] text-ink"><span className="truncate">{bot.name}</span><span className="shrink-0 text-ink-secondary">{bot.action === "add" ? t("settings.sync.previewAdd") : bot.action === "update" ? t("settings.sync.previewUpdate") : t("settings.sync.previewArchive")}</span></div>)}
              </div>
            ) : null}
            {preview.conflicts.length || preview.invalidFiles.length ? <div className="mt-2 flex items-start gap-1.5 text-[12px] text-warning"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{t("settings.sync.conflicts")}</div> : null}
            {preview.conflicts.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2 border-t border-hairline/30 pt-3">
                {preview.conflicts.map((conflict) => (
                  <fieldset key={conflict.id} className="flex flex-col gap-1 text-[12px] text-ink-secondary">
                    <legend className="text-ink">{conflict.field}</legend>
                    {conflict.variants.map((variant) => (
                      <label key={variant.operationId} className="flex items-start gap-2">
                        <input
                          type="radio"
                          name={`sync-conflict-${conflict.id}`}
                          checked={conflictChoices[conflict.id] === variant.operationId}
                          onChange={() => setConflictChoices((current) => ({ ...current, [conflict.id]: variant.operationId }))}
                        />
                        <span className="break-words">{typeof variant.value === "string" ? variant.value : JSON.stringify(variant.value)}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            ) : null}
            {preview.operations > 0 ? <button type="button" onClick={() => void action("import")} disabled={busy !== null || !conflictsResolved || preview.invalidFiles.length > 0} className="mt-3 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40">{t("settings.sync.import")}</button> : null}
          </div>
        ) : null}

        {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
