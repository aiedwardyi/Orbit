import { useEffect, useState } from "react";
import { Cloud, FolderOpen, RefreshCw, Unlink } from "lucide-react";

import { api } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

type SyncStatus = {
  configured: boolean;
  folder: string | null;
  status: "disconnected" | "waiting" | "up-to-date" | "needs-review";
  operations: number;
  invalidFiles: string[];
  lastSyncAt: number | null;
  syncChats: boolean;
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
  const [busy, setBusy] = useState<"choose" | "disconnect" | "chats" | null>(null);
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

  const state = status ?? {
    configured: false,
    folder: null,
    status: "disconnected" as const,
    operations: 0,
    invalidFiles: [],
    lastSyncAt: null,
    syncChats: false,
  };

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

        {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
