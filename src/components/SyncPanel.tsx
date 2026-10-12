import { useEffect, useRef, useState } from "react";

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

type GoogleSync = {
  state:
    | "unavailable"
    | "signed-out"
    | "ready"
    | "joining"
    | "syncing"
    | "up-to-date"
    | "offline"
    | "needs-sign-in"
    | "blocked"
    | "other-account"
    | "folder"
    | "error";
  email: string | null;
  boundEmail: string | null;
  join: { first: boolean; pcs: number } | null;
  progress: { done: number; total: number } | null;
  lastSyncAt: number | null;
  move?: true;
  problem?: string;
};

type Action = { label: string; run: () => void };

const POLL_MS = 5000;

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

// api() drops the status, so a build without the Google route shows up as the server's "no route" error
const missingRoute = (cause: unknown) => cause instanceof Error && /^(no route|404\b)/.test(cause.message);

export function SyncPanel() {
  const { t } = useI18n();
  const [google, setGoogle] = useState<GoogleSync | null>(null);
  const [folder, setFolder] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [showFolder, setShowFolder] = useState(false);
  const attempts = useRef(0);
  const showFolderNow = useRef(false);
  showFolderNow.current = showFolder;

  const message = (cause: unknown) => (cause instanceof Error ? cause.message : t("settings.sync.saveError"));

  const loadFolder = async () => {
    try {
      setFolder(await api("/api/profile-sync"));
      setLoadError("");
    } catch (cause) {
      setLoadError(message(cause));
    }
  };

  const refresh = async () => {
    let next: GoogleSync;
    try {
      next = await api("/api/google-sync");
    } catch (cause) {
      if (!missingRoute(cause)) return setLoadError(message(cause));
      next = { state: "unavailable", email: null, boundEmail: null, join: null, progress: null, lastSyncAt: null };
    }
    setGoogle(next);
    setLoadError("");
    if (next.state === "unavailable" || next.state === "folder" || showFolderNow.current) await loadFolder();
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setNotice(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    const account = window.ogb?.googleAccount;
    if (!account || signingIn) return;
    const attempt = ++attempts.current;
    setSigningIn(true);
    setNotice("");
    const result = await account.signIn().catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    if (attempt !== attempts.current) return;
    setSigningIn(false);
    if (!result.ok) setNotice(result.error);
    await refresh();
  };

  const cancelSignIn = async () => {
    attempts.current++;
    setSigningIn(false);
    await window.ogb?.googleAccount?.cancel().catch(() => undefined);
  };

  const signOut = () =>
    run(async () => {
      await window.ogb?.googleAccount?.signOut();
      await refresh();
    });

  const start = () =>
    run(async () => {
      const init: RequestInit = { method: "POST" };
      if (google?.move) init.body = JSON.stringify({ move: true });
      setGoogle(await api("/api/google-sync/start", init));
    });

  const chooseFolder = async () => {
    const picked = await window.ogb?.pickFolder?.(folder?.folder ?? undefined);
    if (!picked) return;
    await run(async () => {
      setFolder(await api("/api/profile-sync", { method: "PUT", body: JSON.stringify({ folder: picked }) }));
      // The chats switch is gone, so folder sync always includes chats.
      setFolder(await api("/api/profile-sync/chats", { method: "PUT", body: JSON.stringify({ enabled: true }) }));
    });
  };

  const disconnect = () => run(async () => setFolder(await api("/api/profile-sync", { method: "DELETE" })));

  const revealFolder = () => {
    setShowFolder(true);
    void loadFolder();
  };

  const state = google?.state;
  const folderView = state === "unavailable" || state === "folder" || (showFolder && (state === "signed-out" || state === "blocked"));

  let line: string | null = null;
  let main: Action | undefined;
  const quiets: Action[] = [];
  let ready = false;

  if (signingIn && google) {
    ready = true;
    line = t("settings.sync.waitingGoogle");
    quiets.push({ label: t("settings.sync.cancel"), run: () => void cancelSignIn() });
  } else if (folderView) {
    ready = folder !== null;
    if (folder) {
      const label = statusLabel(folder.status, t);
      line = folder.configured ? `${label} · ${folderName(folder.folder)}` : label;
      main = { label: t(folder.configured ? "settings.sync.changeFolder" : "settings.sync.chooseFolder"), run: () => void chooseFolder() };
      if (folder.configured) {
        if (state === "folder" && window.ogb?.googleAccount) {
          quiets.push({ label: t("settings.sync.moveToGoogle"), run: () => void signIn() });
        }
        quiets.push({ label: t("settings.sync.disconnect"), run: () => void disconnect() });
      } else if (showFolder) quiets.push({ label: t("settings.sync.back"), run: () => setShowFolder(false) });
    }
  } else if (google) {
    ready = true;
    const email = google.email ?? "";
    const signInAction = { label: t("settings.sync.signIn"), run: () => void signIn() };
    const signOutAction = { label: t("settings.sync.signOut"), run: () => void signOut() };
    const folderAction = { label: t("settings.sync.useFolder"), run: revealFolder };
    const refused = Boolean(google.move && google.problem);
    if (google.state === "signed-out") {
      if (!window.ogb) line = t("settings.sync.disconnected");
      main = signInAction;
      quiets.push(folderAction);
    } else if (google.state === "ready") {
      if (refused) line = t("settings.sync.otherWorkspace");
      else if (!google.join) line = email;
      else if (google.join.first) line = t("settings.sync.firstPc", { email });
      else line = t("settings.sync.joining", { email, pcs: google.join.pcs });
      if (!refused) main = { label: t("settings.sync.start"), run: () => void start() };
      quiets.push(signOutAction);
    } else if (google.state === "joining" || google.state === "syncing") {
      line = google.progress
        ? t("settings.sync.syncing", { done: google.progress.done, total: google.progress.total })
        : t("settings.sync.syncingNoProgress");
      quiets.push(signOutAction);
    } else if (google.state === "up-to-date") {
      line = t("settings.sync.upToDateAs", { email });
      quiets.push(signOutAction);
    } else if (google.state === "offline") {
      line = t("settings.sync.offline");
      quiets.push(signOutAction);
    } else if (google.state === "needs-sign-in") {
      line = t("settings.sync.needsSignIn");
      main = signInAction;
      quiets.push(signOutAction);
    } else if (google.state === "blocked") {
      line = t("settings.sync.blocked");
      quiets.push(folderAction);
    } else if (google.state === "other-account") {
      line = t("settings.sync.otherAccount", { boundEmail: google.boundEmail ?? "" });
      quiets.push(signOutAction);
    } else {
      line = t("settings.sync.error");
      quiets.push(signOutAction);
    }
  }

  const shown = notice || (ready ? line : loadError);
  const desktop = Boolean(window.ogb);

  return (
    <Card subtitle={t("settings.sync.subtitle")}>
      {shown || (ready && desktop && (main || quiets.length > 0)) ? (
        <div className="flex flex-col gap-3">
          {shown ? <div role="status" className="text-[13px] text-ink">{shown}</div> : null}
          {ready && desktop && (main || quiets.length > 0) ? (
            <div className="flex flex-wrap items-center gap-2">
              {main ? (
                <button type="button" onClick={main.run} disabled={busy} className="rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40">
                  {main.label}
                </button>
              ) : null}
              {quiets.map((action) => (
                <button key={action.label} type="button" onClick={action.run} disabled={busy} className="rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40">
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
