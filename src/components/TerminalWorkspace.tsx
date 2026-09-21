import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from "react";
import { ArrowLeft, ChevronDown, FolderOpen, RotateCcw, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Bot } from "@/state/store";
import { api, useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { readTerminalMatch, terminalTheme, TERMINAL_APPEARANCE_EVENT } from "@/lib/terminal-appearance";
import { ConfirmDialog } from "./ConfirmDialog";
import "@xterm/xterm/css/xterm.css";

type SessionInfo = { cwd: string; shell: string };
type OutputEvent = { id: string; data: string; seq: number };
type TerminalSnapshot = { id: string; cwd: string; shell: string; output: string; exitCode: number | null; seq: number; launchProject?: string | null; label?: string; cols?: number; rows?: number; alternate?: boolean; modes?: number[]; resetModes?: number[] };
type BotPane = { id: string; label: string | null };
const TERMINAL_FONT_MIN = 8;
const TERMINAL_FONT_MAX = 128;

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const norm = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function folderBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || cwd;
}

function paneLabelKey(botId: string): string {
  return `orbit.paneLabel.${botId}`;
}

function paneLabelStore() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readPaneLabel(botId: string): string {
  try {
    return paneLabelStore()?.getItem(paneLabelKey(botId)) ?? "";
  } catch {
    return "";
  }
}

function writePaneLabel(botId: string, value: string): void {
  try {
    const store = paneLabelStore();
    if (!store) return;
    if (value) store.setItem(paneLabelKey(botId), value);
    else store.removeItem(paneLabelKey(botId));
  } catch {
    // quota / private mode - the label just doesn't outlive the mount
  }
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
  const botIdRef = useRef(bot.id);
  const blockedRef = useRef(focusBlocked || !visible);
  const openShellRef = useRef<((restart: boolean) => void) | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const replacingRef = useRef(false);
  const forwardInputRef = useRef<(data: string) => void>(() => {});
  const composingRef = useRef(false);
  const labelCancelRef = useRef(false);
  useLayoutEffect(() => {
    blockedRef.current = focusBlocked || !visible;
    visibleRef.current = visible;
    projectRef.current = bot.cwd ?? null;
    botIdRef.current = bot.id;
  }, [focusBlocked, visible, bot.cwd, bot.id]);
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [needsFolder, setNeedsFolder] = useState(false);
  const [folderReason, setFolderReason] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [paneLabel, setPaneLabel] = useState(() => readPaneLabel(bot.id));
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [panes, setPanes] = useState<BotPane[]>([]);
  const [pane, setPane] = useState<string | null>(null);
  const activeLabel = pane ? panes.find((item) => item.id === pane)?.label ?? "" : paneLabel;

  const projectMismatch = Boolean(session && !samePath(bot.cwd ?? null, launchProject));
  const showProjectBanner = projectMismatch && !bannerDismissed;
  const folderLabel = bot.cwd ? folderBasename(bot.cwd) : t("terminal.privateWorkspace");
  const folderTooltip = bot.cwd ?? t("terminal.privateWorkspace");

  useEffect(() => {
    setBannerDismissed(false);
  }, [bot.cwd]);

  useEffect(() => {
    setPaneLabel(readPaneLabel(bot.id));
    setEditingLabel(false);
  }, [bot.id]);

  // Bot-spawned panes: seeded once, then pushed by the host on open.
  useEffect(() => {
    const bridge = window.ogb?.terminal;
    setPanes([]);
    setPane(null);
    if (!bridge) return;
    let alive = true;
    void Promise.resolve().then(() => bridge.readBot?.(bot.id)).then((snapshot) => {
      if (!alive || !snapshot?.panes) return;
      const seeded = snapshot.panes.filter((item) => !item.main).map((item) => ({ id: item.sessionId, label: item.label }));
      setPanes((list) => [...seeded, ...list.filter((item) => !seeded.some((seed) => seed.id === item.id))]);
    }).catch(() => {});
    const offOpened = bridge.onOpened?.((event) => {
      if (event.botId !== bot.id) return;
      setPanes((list) => list.some((item) => item.id === event.id) ? list : [...list, { id: event.id, label: event.label }]);
    });
    return () => {
      alive = false;
      offOpened?.();
    };
  }, [bot.id]);

  useEffect(() => {
    setEditingLabel(false);
  }, [pane]);

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
    let replayComplete = false;
    const liveQueue: OutputEvent[] = [];
    const exits = new Map<string, number>();
    setSession(null);
    setLaunchProject(null);
    setExitCode(null);
    setError("");
    setNeedsFolder(false);
    setFolderReason(null);
    setReplacing(false);
    replacingRef.current = false;
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
    // Ctrl+click follows links: xterm reports mousedown bytes before the linkifier
    // activates, so plain-click links would also click through to mouse-mode TUIs.
    const openLink = (event: MouseEvent, url: string) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!/^https?:\/\//i.test(url)) return;
      void window.ogb?.openExternal?.(url);
    };
    const showLink = (url: string | null) => {
      if (url) host.title = url;
      else host.removeAttribute("title");
    };
    const links = new WebLinksAddon(openLink, {
      hover: (_event, text) => showLink(text),
      leave: () => showLink(null),
    });
    terminal.loadAddon(links);
    terminal.options.linkHandler = {
      activate: openLink,
      hover: (_event, text) => showLink(text),
      leave: () => showLink(null),
    };
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
      terminal.options.theme = { ...terminalTheme(color), ...imported?.theme };
      if (host.parentElement) host.parentElement.style.backgroundColor = imported?.theme.background ?? "";
      fit.fit();
      if (id) {
        const sessionId = id;
        void Promise.resolve().then(() => bridge.resize(sessionId, terminal.cols, terminal.rows)).catch(report);
      }
    };
    void theme();
    fit.fit();
    const receive = (event: OutputEvent) => {
      if (event.id !== id || event.seq <= lastSeq) return;
      if (!replayComplete) {
        liveQueue.push(event);
        return;
      }
      lastSeq = event.seq;
      terminal.write(event.data);
    };
    const offData = bridge.onData((event) => {
      if (!replayComplete) liveQueue.push(event);
      else receive(event);
    });
    const offExit = bridge.onExit((event) => {
      if (!replayComplete || event.id === id) exits.set(event.id, event.exitCode);
      if (event.id === id) {
        terminal.options.disableStdin = true;
        setExitCode(event.exitCode);
      }
    });
    const offError = bridge.onError?.((event) => {
      if (event.id === id) {
        terminal.options.disableStdin = true;
        report(event.message);
      }
    });
    // Forward keystrokes and emulator replies only after historical replay finishes.
    // onBinary carries non-UTF8 mouse reports (wheel in X10/RXVT mode); without it the wheel is dropped.
    const forwardInput = (data: string) => {
      if (!id || !replayComplete || terminal.options.disableStdin || exits.has(id)) return;
      const sessionId = id;
      const send = () => Promise.resolve(bridge.write(sessionId, data)).catch(report);
      // Submit keys skip the microtask queue so they cannot stall behind DA/mouse replies.
      if (/[\r\n]/.test(data)) void send();
      else void Promise.resolve().then(send);
    };
    forwardInputRef.current = forwardInput;
    const input = terminal.onData(forwardInput);
    const inputBinary = terminal.onBinary(forwardInput);
    // Windows Terminal copy/paste. xterm maps Ctrl+C/V to raw control bytes
    // (^C/^V) and leaves Shift+Insert dead, so claim them here. False claims.
    const copySelection = (text: string) => {
      const finish = () => {
        if (alive) terminal.clearSelection();
      };
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .catch(() => window.ogb?.clipboard?.writeText(text))
        .then(finish, finish);
    };
    const readClipboardText = async (): Promise<string> => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        // Renderer clipboard is unreadable; try the native bridge next.
      }
      try {
        return (await window.ogb?.clipboard?.readText()) ?? "";
      } catch {
        return "";
      }
    };
    const pasteClipboard = () => {
      void readClipboardText().then((text) => {
        if (!alive || !text) return;
        if (terminal.options.disableStdin) return;
        terminal.paste(text);
      });
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.metaKey || event.altKey) return true;
      if (terminal.options.disableStdin || (id !== null && exits.has(id))) return true;
      const key = (event.key ?? "").toLowerCase();
      const isCopyKey = key === "c" || event.keyCode === 67;
      const isPasteKey = key === "v" || event.keyCode === 86;
      const isInsertKey = key === "insert" || event.keyCode === 45;
      if (event.ctrlKey && isCopyKey) {
        // Bare Ctrl+C with no selection keeps today's ^C (interrupt/close).
        if (!event.shiftKey && !terminal.hasSelection()) return true;
        const selected = terminal.getSelection();
        if (selected) copySelection(selected);
        else terminal.clearSelection();
        return false;
      }
      if (event.ctrlKey && isPasteKey) {
        // Native paste owns this: false skips xterm's ^V mapping without
        // canceling the keydown, so Chromium fires one paste on the textarea.
        return false;
      }
      if (event.shiftKey && !event.ctrlKey && isInsertKey) {
        event.preventDefault();
        pasteClipboard();
        return false;
      }
      return true;
    });
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || !host.clientWidth || !host.clientHeight) return;
        fit.fit();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        if (id) {
          const sessionId = id;
          void Promise.resolve().then(() => bridge.resize(sessionId, terminal.cols, terminal.rows)).catch(report);
        }
      });
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const updateAppearance = () => { void theme(); };
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
    const appearance = new MutationObserver(() => { void theme(); resize(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-shape"] });

    let attachedLaunchProject: string | null = null;
    const finishAttach = (snapshot: TerminalSnapshot, launchedProject: string | null, modesRestored = false) => {
      if (!alive) return;
      if (!modesRestored) {
        const restoreModes = [
          ...(snapshot.resetModes ?? []).map((mode) => `\x1b[?${mode}l`),
          ...(snapshot.modes ?? [])
            .filter((mode) => mode !== 47 && mode !== 1047 && mode !== 1049)
            .map((mode) => `\x1b[?${mode}h`),
        ]
          .join("");
        if (restoreModes) {
          terminal.write(restoreModes, () => finishAttach(snapshot, launchedProject, true));
          return;
        }
      }
      // Use lastSeq (not snapshot.seq): same-id fallback never advances lastSeq to
      // resumed.seq, so IPC-gap events in (lastSeq, snapshot.seq] stay drainable.
      const queued = [...liveQueue]
        .filter((event) => event.id === snapshot.id && event.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      liveQueue.length = 0;
      replayComplete = true;
      for (const event of queued) receive(event);
      if (!pane && snapshot.label) {
        setPaneLabel(snapshot.label);
        writePaneLabel(bot.id, snapshot.label);
      } else if (!pane) {
        const stored = readPaneLabel(bot.id);
        if (stored) void Promise.resolve().then(() => bridge.setLabel?.(snapshot.id, stored)).catch(() => {});
      }
      const code = exits.get(snapshot.id) ?? snapshot.exitCode;
      if (code !== null) exits.set(snapshot.id, code);
      setExitCode(code);
      terminal.options.disableStdin = code !== null;
      setSession({ cwd: snapshot.cwd, shell: snapshot.shell });
      const project = "launchProject" in snapshot ? snapshot.launchProject ?? null : launchedProject;
      attachedLaunchProject = project;
      setLaunchProject(project);
      setNeedsFolder(false);
      setFolderReason(null);
      setBannerDismissed(false);
      setReplacing(false);
      replacingRef.current = false;
      resize();
      // Diff-rendering TUIs cannot be rebuilt from replayed history alone; a size
      // bounce forces the app to repaint from live state (same trio a manual resize runs).
      if (snapshot.alternate === true && code === null && terminal.rows > 1) {
        const repaintId = snapshot.id;
        const repaintCols = terminal.cols;
        const repaintRows = terminal.rows;
        void Promise.resolve()
          .then(() => bridge.resize(repaintId, repaintCols, repaintRows - 1))
          .then(() => bridge.resize(repaintId, repaintCols, repaintRows))
          .catch(report);
      }
      if (!blockedRef.current) terminal.focus();
    };

    const recoverPreservedSession = () => {
      if (!id) return;
      const isExited = exits.has(id);
      const queued = [...liveQueue]
        .filter((event) => event.id === id && event.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      liveQueue.length = 0;
      replayComplete = true;
      for (const event of queued) receive(event);
      terminal.options.disableStdin = isExited;
      if (isExited) {
        setExitCode(exits.get(id)!);
      } else if (!blockedRef.current) {
        terminal.focus();
      }
    };

    const openShell = (restart: boolean) => {
      if (!alive || opening || !visibleRef.current) return;
      if (id && !restart) return;
      if (restart && replacingRef.current) return;
      const expectedBotId = botIdRef.current;
      const expectedProject = projectRef.current;
      opening = true;
      if (restart) {
        replacingRef.current = true;
        setReplacing(true);
      }
      setError("");
      setNeedsFolder(false);
      setFolderReason(null);
      liveQueue.length = 0;
      replayComplete = false;
      terminal.options.disableStdin = true;
      const openInput: Parameters<typeof bridge.open>[0] = { botId: expectedBotId, cols: terminal.cols, rows: terminal.rows, restart, projectCwd: expectedProject };
      if (pane) openInput.sessionId = pane;
      void Promise.resolve().then(() => bridge.open(openInput)).then(async (result) => {
        opening = false;
        if (!alive) return;
        if (botIdRef.current !== expectedBotId) {
          setReplacing(false);
          replacingRef.current = false;
          return;
        }
        if ("needsFolder" in result && result.needsFolder) {
          if (restart) {
            // Host keeps the prior session when the new target is unavailable.
            // Defer needsFolder until fallback open settles — avoid flashing the banner mid-resume.
            try {
              const resumed = await bridge.open({ botId: expectedBotId, cols: terminal.cols, rows: terminal.rows, restart: false });
              if (!alive) return;
              if (botIdRef.current !== expectedBotId) {
                setReplacing(false);
                replacingRef.current = false;
                return;
              }
              if (!("needsFolder" in resumed)) {
                // Same session already painted in xterm — skip re-dump to avoid duplicate scrollback.
                if (resumed.id !== id) {
                  id = resumed.id;
                  sessionIdRef.current = resumed.id;
                  lastSeq = resumed.seq;
                  replayComplete = false;
                  terminal.write(resumed.output, () => finishAttach(resumed, expectedProject));
                } else {
                  // Same session already painted — skip re-dump, but still finishAttach for live drain + resize/focus.
                  // Keep lastSeq at the pre-restart watermark so finishAttach preserves IPC-gap events.
                  finishAttach(resumed, attachedLaunchProject);
                }
                return;
              }
              setNeedsFolder(true);
              setFolderReason(resumed.reason ?? result.reason ?? "choose-folder");
              recoverPreservedSession();
            } catch (cause) {
              report(cause);
              setNeedsFolder(true);
              setFolderReason(result.reason ?? "choose-folder");
              recoverPreservedSession();
            }
            setReplacing(false);
            replacingRef.current = false;
          } else {
            setNeedsFolder(true);
            setFolderReason(result.reason ?? "choose-folder");
            id = null;
            sessionIdRef.current = null;
            setSession(null);
            setLaunchProject(null);
            setReplacing(false);
            replacingRef.current = false;
          }
          return;
        }
        // SAFETY: this branch follows the needsFolder discriminant from the terminal bridge.
        const snapshot = result as TerminalSnapshot;
        id = snapshot.id;
        sessionIdRef.current = snapshot.id;
        lastSeq = snapshot.seq;
        replayComplete = false;
        terminal.write(snapshot.output, () => finishAttach(snapshot, expectedProject));
      }).catch((cause) => {
        opening = false;
        setReplacing(false);
        replacingRef.current = false;
        if (!alive || botIdRef.current !== expectedBotId) return;
        report(cause);
        if (restart) recoverPreservedSession();
      });
    };
    openShellRef.current = openShell;
    if (visibleRef.current) openShell(generation > 0);

    return () => {
      alive = false;
      if (bridge.cancelOpen) void bridge.cancelOpen(bot.id).catch(() => {});
      openShellRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      appearance.disconnect();
      window.removeEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
      offData();
      offExit();
      offError?.();
      input.dispose();
      inputBinary.dispose();
      links.dispose();
      host.removeAttribute("title");
      forwardInputRef.current = () => {};
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      resizeRef.current = null;
      sessionIdRef.current = null;
    };
  }, [bot.id, generation, pane]);

  // Hidden remount stays quiet; becoming visible opens or resumes once.
  useEffect(() => {
    if (visible) {
      openShellRef.current?.(false);
      // The overlay keeps layout size while hidden, so no ResizeObserver fires on
      // return; run the resize trio (fit + refresh + PTY sync) explicitly.
      resizeRef.current?.();
    }
  }, [visible]);

  useEffect(() => {
    if (visible && !focusBlocked) terminalRef.current?.focus();
  }, [visible, focusBlocked]);

  const onTerminalWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    event.preventDefault();
    event.stopPropagation();
    const current = terminal.options.fontSize ?? 13;
    const next = Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, current + (event.deltaY < 0 ? 1 : -1)));
    if (next === current) return;
    terminal.options.fontSize = next;
    resizeRef.current?.();
  };

  const chooseAndPersist = async () => {
    if (choosing) return;
    setChoosing(true);
    setError("");
    try {
      const picked = await window.ogb?.pickFolder?.(bot.cwd ?? undefined);
      if (!picked) return;
      const result: { bot?: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd: picked }),
      });
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      setNeedsFolder(false);
      setFolderReason(null);
      // Persist only - never inject cd or kill a live session from folder pick.
      if (!sessionIdRef.current) setGeneration((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };

  const requestRestartHere = () => {
    if (replacing || replacingRef.current) return;
    if (exitCode === null && sessionIdRef.current) setConfirmRestart(true);
    else {
      setBannerDismissed(false);
      // Dead/missing session: in-place restart (restart:true). openShell(false) would early-return while id is still set.
      if (openShellRef.current) openShellRef.current(true);
      else setGeneration((value) => value + 1);
    }
  };

  const startLabelEdit = () => {
    labelCancelRef.current = false;
    setLabelDraft(activeLabel);
    setEditingLabel(true);
  };

  const finishLabelEdit = (save: boolean) => {
    if (save) {
      const next = labelDraft.trim().slice(0, 40);
      const id = pane ?? sessionIdRef.current;
      if (pane) setPanes((list) => list.map((item) => item.id === pane ? { ...item, label: next || null } : item));
      else {
        setPaneLabel(next);
        writePaneLabel(bot.id, next);
      }
      if (id) void Promise.resolve().then(() => window.ogb?.terminal?.setLabel?.(id, next)).catch(() => {});
    }
    setEditingLabel(false);
  };

  const closePane = (id: string) => {
    setPanes((list) => list.filter((item) => item.id !== id));
    if (pane === id) setPane(null);
    void Promise.resolve().then(() => window.ogb?.terminal?.close?.(id)).catch(() => {});
  };

  // Escape unmounts the input, which can fire blur after cancel.
  const blurLabelEdit = () => {
    if (labelCancelRef.current) {
      labelCancelRef.current = false;
      return;
    }
    finishLabelEdit(true);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset text-ink" aria-label={t("terminal.title")}>
      <header className="flex min-h-[60px] shrink-0 items-center gap-3 border-b border-hairline bg-panel py-3 pl-11 pr-5 md:pl-5">
        <button type="button" onClick={onClose} className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text">
          <ArrowLeft size={15} /> {t("terminal.chat")} <kbd className="text-[10px] text-ink-secondary">{window.ogb?.platform === "darwin" ? "⌘" : "Ctrl+"}`</kbd>
        </button>
        <span className="h-5 border-l border-hairline" aria-hidden />
        <TerminalSquare size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{t("terminal.title")} <span className="text-ink-secondary">/ {bot.name}</span></h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void chooseAndPersist()}
              disabled={choosing || replacing}
              title={folderTooltip}
              aria-label={t("terminal.chooseFolder")}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text disabled:opacity-60"
            >
              <FolderOpen size={12} className="shrink-0" />
              <span className="min-w-0 truncate font-mono">{folderLabel}</span>
              <ChevronDown size={11} className="shrink-0 opacity-70" />
            </button>
            {editingLabel ? (
              <input
                autoFocus
                value={labelDraft}
                maxLength={40}
                aria-label={activeLabel ? t("terminal.editLabel") : t("terminal.addLabel")}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setLabelDraft(event.target.value.slice(0, 40))}
                onBlur={blurLabelEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    finishLabelEdit(true);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    labelCancelRef.current = true;
                    finishLabelEdit(false);
                  }
                }}
                className="w-36 shrink-0 rounded-md border border-hairline bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text"
              />
            ) : activeLabel ? (
              <button
                type="button"
                onClick={startLabelEdit}
                aria-label={t("terminal.editLabel")}
                title={activeLabel}
                className="inline-flex min-w-0 max-w-[180px] shrink-0 items-center rounded-md border border-hairline bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text"
              >
                <span className="truncate">{activeLabel}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={startLabelEdit}
                aria-label={t("terminal.addLabel")}
                className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary/70 hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text"
              >
                {t("terminal.addLabel")}
              </button>
            )}
            {projectMismatch && bannerDismissed ? (
              <span className="shrink-0 text-[11px] text-ink-secondary" title={launchProject ?? undefined}>· {t("terminal.differentProject")}</span>
            ) : null}
          </div>
          {panes.length > 0 && (
            <div role="tablist" className="mt-1 flex min-w-0 items-center gap-1 overflow-x-auto">
              {[{ id: null, label: paneLabel || t("terminal.title") }, ...panes.map((item) => ({ id: item.id, label: item.label || item.id.slice(0, 8) }))].map((tab) => (
                <div key={tab.id ?? "main"} className={`inline-flex max-w-[220px] shrink-0 items-center rounded-md border font-mono text-[11px] ${pane === tab.id ? "border-accent-text text-ink" : "border-hairline text-ink-secondary hover:text-ink"}`}>
                  <button type="button" role="tab" aria-selected={pane === tab.id} onClick={() => setPane(tab.id)} title={tab.label} className="min-w-0 truncate px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text">
                    {tab.label}
                  </button>
                  {tab.id && (
                    <button type="button" onClick={() => closePane(tab.id)} aria-label={t("terminal.close")} className="shrink-0 rounded p-0.5 hover:bg-raised">
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {bot.busy && <span className="shrink-0 text-[11px] text-accent-text" role="status">{t("terminal.agentWorking")}</span>}
        <button
          type="button"
          onClick={requestRestartHere}
          disabled={replacing || choosing || pane !== null}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text disabled:opacity-60"
        >
          <RotateCcw size={13} className={replacing ? "animate-spin" : undefined} />
          {t("terminal.headerRestart")}
        </button>
      </header>
      {showProjectBanner && (
        <div role="status" className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-inset px-5 py-1.5 text-[12px] text-ink">
          <span className="min-w-0 flex-1" title={launchProject ?? undefined}>
            {t("terminal.projectChanged")}
            {launchProject ? <span className="ml-2 font-mono text-[11px] text-ink-secondary">{launchProject}</span> : null}
          </span>
          <button type="button" onClick={requestRestartHere} disabled={replacing} className="shrink-0 text-accent-text underline disabled:opacity-60">
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
          <button type="button" onClick={() => setGeneration((value) => value + 1)} disabled={replacing} className="shrink-0 underline disabled:opacity-60">{t("terminal.retry")}</button>
        </div>
      )}
      <div
        data-orbit-terminal
        className="min-h-0 flex-1 p-4"
        onKeyDownCapture={(event) => {
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.nativeEvent.isComposing ||
            composingRef.current ||
            event.keyCode === 229 ||
            event.nativeEvent.keyCode === 229 ||
            event.repeat
          ) return;
          event.preventDefault();
          event.stopPropagation();
          forwardInputRef.current("\r");
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onWheelCapture={onTerminalWheel}
      >
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline bg-panel px-5 py-2 text-[11px] text-ink-secondary">
        <span>
          {exitCode === null
            ? session?.shell.split(/[\\/]/).at(-1) ?? (needsFolder ? t("terminal.chooseFolder") : error ? t("terminal.unavailable") : t("terminal.connecting"))
            : t("terminal.exited", { code: exitCode })}
        </span>
        {exitCode !== null ? (
          <button type="button" onClick={requestRestartHere} disabled={replacing} className="text-accent-text underline disabled:opacity-60">{t("terminal.restart")}</button>
        ) : (
          <span>{t("terminal.lifetime")}</span>
        )}
      </footer>
      {confirmRestart && (
        <ConfirmDialog
          title={t("terminal.restartConfirmTitle", { folder: folderLabel })}
          body={t("terminal.restartConfirmBody")}
          confirmLabel={t("terminal.restartConfirmAction")}
          danger
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            setBannerDismissed(false);
            // In-place restart keeps painted scrollback; fallback can skip re-dump when session id matches.
            if (openShellRef.current) openShellRef.current(true);
            else setGeneration((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

