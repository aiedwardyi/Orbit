import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Bot } from "@/state/store";
import { api, useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { readTerminalMatch, TERMINAL_APPEARANCE_EVENT } from "@/lib/terminal-appearance";
import { ConfirmDialog } from "./ConfirmDialog";
import "@xterm/xterm/css/xterm.css";

type SessionInfo = { cwd: string; shell: string };

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const norm = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function TerminalWorkspace({
  bot,
  onClose,
  focusBlocked,
  visible,
}: {
  bot: Pick<Bot, "id" | "name" | "busy" | "cwd">;
  onClose: () => void;
  focusBlocked: boolean;
  visible: boolean;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  const projectRef = useRef(bot.cwd ?? null);
  const blockedRef = useRef(focusBlocked || !visible);
  const openShellRef = useRef<((restart: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    blockedRef.current = focusBlocked || !visible;
    visibleRef.current = visible;
    projectRef.current = bot.cwd ?? null;
  }, [focusBlocked, visible, bot.cwd]);
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [needsFolder, setNeedsFolder] = useState(false);
  const [folderReason, setFolderReason] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const projectMismatch = Boolean(session && !samePath(bot.cwd ?? null, launchProject));
  const showProjectBanner = projectMismatch && !bannerDismissed;

  useEffect(() => {
    setBannerDismissed(false);
  }, [bot.cwd]);

  // xterm + bridge listeners for this bot. Shell open waits until visible.
  useEffect(() => {
    const host = hostRef.current;
    const bridge = window.ogb?.terminal;
    if (!host || !bridge) return;
    let alive = true;
    let id: string | null = null;
    let lastSeq = 0;
    let frame = 0;
    let appearanceRequest = 0;
    let opening = false;
    const pending: Array<{ id: string; data: string; seq: number }> = [];
    const exits = new Map<string, number>();
    setSession(null);
    setLaunchProject(null);
    setExitCode(null);
    setError("");
    setNeedsFolder(false);
    setFolderReason(null);
    sessionIdRef.current = null;
    const terminal = new Terminal({
      cursorBlink: false,
      fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "Cascadia Code NF", "Cascadia Mono", Consolas, "Malgun Gothic", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: false,
      disableStdin: true,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    const report = (cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); };
    const defaultFont = terminal.options.fontFamily;
    const theme = async () => {
      const request = ++appearanceRequest;
      const imported = readTerminalMatch() ? await bridge.appearance?.().catch(() => null) : null;
      if (!alive || request !== appearanceRequest) return;
      const css = getComputedStyle(host);
      const color = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
      terminal.options.fontFamily = imported?.fontFamily ? `${JSON.stringify(imported.fontFamily)}, monospace` : defaultFont;
      terminal.options.fontSize = imported?.fontSize ?? 13;
      terminal.options.theme = {
        background: color("inset"), foreground: color("ink"),
        cursor: color("accent-text"), cursorAccent: color("inset"),
        selectionBackground: color("raised-hover"),
        ...imported?.theme,
      };
      if (host.parentElement) host.parentElement.style.backgroundColor = imported?.theme.background ?? "";
      fit.fit();
      if (id) void bridge.resize(id, terminal.cols, terminal.rows).catch(report);
    };
    void theme();
    fit.fit();
    const receive = (event: { id: string; data: string; seq: number }) => {
      if (event.id !== id || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      terminal.write(event.data);
    };
    const offData = bridge.onData((event) => {
      if (id === null) pending.push(event);
      else receive(event);
    });
    const offExit = bridge.onExit((event) => {
      if (id === null) exits.set(event.id, event.exitCode);
      else if (event.id === id) {
        terminal.options.disableStdin = true;
        setExitCode(event.exitCode);
      }
    });
    const input = terminal.onData((data) => { if (id) void bridge.write(id, data).catch(report); });
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || !host.clientWidth || !host.clientHeight) return;
        fit.fit();
        if (id) void bridge.resize(id, terminal.cols, terminal.rows).catch(report);
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const updateAppearance = () => { void theme(); };
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
    const appearance = new MutationObserver(() => { void theme(); resize(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-shape"] });

    const openShell = (restart: boolean) => {
      if (!alive || opening || !visibleRef.current) return;
      if (id && !restart) return;
      opening = true;
      setError("");
      setNeedsFolder(false);
      setFolderReason(null);
      void bridge.open({ botId: bot.id, cols: terminal.cols, rows: terminal.rows, restart }).then((result) => {
        opening = false;
        if (!alive) return;
        if ("needsFolder" in result && result.needsFolder) {
          id = null;
          sessionIdRef.current = null;
          setSession(null);
          setLaunchProject(null);
          setNeedsFolder(true);
          setFolderReason(result.reason ?? "choose-folder");
          return;
        }
        const snapshot = result as { id: string; cwd: string; shell: string; output: string; exitCode: number | null; seq: number };
        id = snapshot.id;
        sessionIdRef.current = snapshot.id;
        lastSeq = snapshot.seq;
        terminal.write(snapshot.output);
        for (const event of pending) receive(event);
        pending.length = 0;
        const code = exits.get(id) ?? snapshot.exitCode;
        setExitCode(code);
        terminal.options.disableStdin = code !== null;
        setSession({ cwd: snapshot.cwd, shell: snapshot.shell });
        setLaunchProject(projectRef.current);
        setNeedsFolder(false);
        setFolderReason(null);
        setBannerDismissed(false);
        resize();
        if (!blockedRef.current) terminal.focus();
      }).catch((cause) => {
        opening = false;
        report(cause);
      });
    };
    openShellRef.current = openShell;
    if (visibleRef.current) openShell(generation > 0);

    return () => {
      alive = false;
      openShellRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      appearance.disconnect();
      window.removeEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
      offData();
      offExit();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      sessionIdRef.current = null;
    };
  }, [bot.id, generation]);

  // Hidden remount stays quiet; becoming visible opens or resumes once.
  useEffect(() => {
    if (visible) openShellRef.current?.(false);
  }, [visible]);

  useEffect(() => {
    if (visible && !focusBlocked) terminalRef.current?.focus();
  }, [visible, focusBlocked]);

  const chooseAndPersist = async () => {
    if (choosing) return;
    setChoosing(true);
    setError("");
    try {
      const picked = await window.ogb?.pickFolder?.(bot.cwd ?? undefined);
      if (!picked) {
        setNeedsFolder(true);
        return;
      }
      const result: { bot?: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd: picked }),
      });
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      setNeedsFolder(false);
      setFolderReason(null);
      setGeneration((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };

  const requestRestartHere = () => {
    if (exitCode === null && sessionIdRef.current) setConfirmRestart(true);
    else {
      setBannerDismissed(false);
      setGeneration((value) => value + 1);
    }
  };

  const headerPath = session
    ? t("terminal.startedIn", { folder: session.cwd })
    : needsFolder
      ? t("terminal.chooseFolder")
      : error
        ? t("terminal.unavailable")
        : t("terminal.connecting");

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset text-ink" aria-label={t("terminal.title")}>
      <header className="flex min-h-[60px] shrink-0 items-center gap-3 border-b border-hairline bg-panel py-3 pl-11 pr-5 md:pl-5">
        <button type="button" onClick={onClose} className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
          <ArrowLeft size={15} /> {t("terminal.chat")} <kbd className="text-[10px] text-ink-secondary">{window.ogb?.platform === "darwin" ? "⌘" : "Ctrl+"}`</kbd>
        </button>
        <span className="h-5 border-l border-hairline" aria-hidden />
        <TerminalSquare size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{t("terminal.title")} <span className="text-ink-secondary">/ {bot.name}</span></h1>
          <p className="truncate font-mono text-[11px] text-ink-secondary" title={session?.cwd}>
            {headerPath}
            {projectMismatch && bannerDismissed ? (
              <span className="ml-2 font-sans text-ink-secondary">· {t("terminal.differentProject")}</span>
            ) : null}
          </p>
        </div>
        {bot.busy && <span className="shrink-0 text-[11px] text-accent-text" role="status">{t("terminal.agentWorking")}</span>}
      </header>
      {showProjectBanner && (
        <div role="status" className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-inset px-5 py-1.5 text-[12px] text-ink">
          <span className="min-w-0 flex-1" title={bot.cwd ?? undefined}>{t("terminal.projectChanged")}</span>
          <button type="button" onClick={requestRestartHere} className="shrink-0 text-accent-text underline">
            {t("terminal.restartHere")}
          </button>
          <button type="button" onClick={() => setBannerDismissed(true)} className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("terminal.dismissBanner")}>
            <X size={14} />
          </button>
        </div>
      )}
      {needsFolder && (
        <div
          role={folderReason === "explicit-unavailable" ? "alert" : "status"}
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 text-[13px] ${
            folderReason === "explicit-unavailable" ? "border-danger/30 bg-danger/10 text-danger" : "border-hairline bg-panel text-ink"
          }`}
        >
          <span>{folderReason === "explicit-unavailable" ? t("terminal.folderMissing") : t("terminal.chooseFolderHelp")}</span>
          <button type="button" onClick={() => void chooseAndPersist()} disabled={choosing} className="inline-flex shrink-0 items-center gap-1.5 text-accent-text underline disabled:opacity-60">
            <FolderOpen size={14} /> {t("terminal.chooseFolder")}
          </button>
        </div>
      )}
      {error && !needsFolder && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/30 bg-danger/10 px-5 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => setGeneration((value) => value + 1)} className="shrink-0 underline">{t("terminal.retry")}</button>
        </div>
      )}
      <div data-orbit-terminal className="min-h-0 flex-1 p-4" onKeyDown={(event) => event.stopPropagation()}>
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline bg-panel px-5 py-2 text-[11px] text-ink-secondary">
        <span>
          {exitCode === null
            ? session?.shell.split(/[\\/]/).at(-1) ?? (needsFolder ? t("terminal.chooseFolder") : error ? t("terminal.unavailable") : t("terminal.connecting"))
            : t("terminal.exited", { code: exitCode })}
        </span>
        {exitCode !== null ? (
          <button type="button" onClick={() => setGeneration((value) => value + 1)} className="text-accent-text underline">{t("terminal.restart")}</button>
        ) : (
          <span>{t("terminal.lifetime")}</span>
        )}
      </footer>
      {confirmRestart && (
        <ConfirmDialog
          title={t("terminal.restartConfirmTitle")}
          body={t("terminal.restartConfirmBody", { folder: bot.cwd || t("bot.workingFolderEmpty") })}
          confirmLabel={t("terminal.restartConfirmAction")}
          danger
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            setBannerDismissed(false);
            setGeneration((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}
