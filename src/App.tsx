import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Menu } from "lucide-react";
import {
  StoreProvider,
  openNotificationTarget,
  terminalAttentionForBot,
  terminalAttentionCount,
  terminalAttentionKey,
  useStore,
  visibleNotificationThread,
  type Bot,
  type Group,
  type TerminalAttention,
} from "@/state/store";
import { unreadConversationCount } from "@/lib/unread";
import { preferredStartupSelectionId } from "@/lib/sidebar-order";
import { loadSidebarOrder } from "@/lib/sidebar-preferences";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { showComputerPanelChrome } from "@/lib/friends-chrome";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { buildTerminalNotification, showNotification, type NotificationTarget } from "@/lib/notify";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { BackNavigation, type BackLayer } from "@/lib/back-navigation";

const Onboarding = lazy(() => import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })));
const SettingsPanel = lazy(() => import("@/components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const PluginsPanel = lazy(() => import("@/components/PluginsPanel").then((m) => ({ default: m.PluginsPanel })));
const ComputerPanel = lazy(() => import("@/components/ComputerPanel").then((m) => ({ default: m.ComputerPanel })));
const InspectorPanel = lazy(() => import("@/components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })));
const SettingsModal = lazy(() => import("@/components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const RoutinesPage = lazy(() => import("@/components/RoutinesPage").then((m) => ({ default: m.RoutinesPage })));
const NoEngines = lazy(() => import("@/components/NoEngines").then((m) => ({ default: m.NoEngines })));
const CommandPalette = lazy(() => import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const LocalVmWorkspace = lazy(() => import("@/components/LocalVmWorkspace").then((m) => ({ default: m.LocalVmWorkspace })));
const BrowserWorkspace = lazy(() => import("@/components/BrowserWorkspace").then((m) => ({ default: m.BrowserWorkspace })));
const SkillRecorderPage = lazy(() => import("@/components/SkillRecorderPage").then((m) => ({ default: m.SkillRecorderPage })));
const TeamMapPage = lazy(() => import("@/components/TeamMapPage").then((m) => ({ default: m.TeamMapPage })));
const CreateBotSheet = lazy(() => import("@/components/CreateBotSheet").then((m) => ({ default: m.CreateBotSheet })));
const TerminalWorkspace = lazy(() => import("@/components/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace })));
const RemoteTerminalView = lazy(() => import("@/components/RemoteTerminalView").then((m) => ({ default: m.RemoteTerminalView })));

function BootFallback({
  label,
  hint,
}: {
  label?: string;
  hint?: ReactNode;
}) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
      <Loader2 size={20} className="animate-spin" />
      {label ? <div className="text-[14px]">{label}</div> : null}
      {hint ? <div className="text-[12px]">{hint}</div> : null}
    </main>
  );
}

/** Selecting a bot that no longer exists falls back to the sidebar's own
 * first item, never raw server creation order. */
function fallbackStartupBot(bots: Bot[], groups: Group[]): Bot | undefined {
  const id = preferredStartupSelectionId(bots, groups, loadSidebarOrder());
  return bots.find((b) => b.id === id) ?? bots[0];
}

function Shell({ onboardingOpen }: { onboardingOpen: boolean }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const latestState = useRef(state);
  const handledTerminalAttention = useRef(new Set<string>());
  const pendingTerminalAcknowledgements = useRef(new Map<string, Set<string>>());
  useLayoutEffect(() => {
    latestState.current = state;
  }, [state]);
  const unreadCount = unreadConversationCount(state.bots, state.groups) + terminalAttentionCount(state.terminalAttention);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [sidebarOverlay, setSidebarOverlay] = useState<string | null>(null);
  const modelPickerIds = useRef(new Set<string>());
  const [terminalViews, setTerminalViews] = useState<Record<string, boolean>>({});
  const [paneHotkey, setPaneHotkey] = useState<{ n: number } | null>(null);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? fallbackStartupBot(state.bots, state.groups));
  const terminalOpen = Boolean(bot && terminalViews[bot.id] && state.activeView === "chat" && !browserWorkspaceBotId && !localVmWorkspaceBotId);
  const openTerminal = () => { if (bot) setTerminalViews((views) => ({ ...views, [bot.id]: true })); };
  const acknowledgeTerminalAttention = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const key = terminalAttentionKey(attention.botId, attention.sessionId);
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId);
    sessions?.delete(attention.sessionId);
    if (sessions?.size === 0) pendingTerminalAcknowledgements.current.delete(attention.botId);
    handledTerminalAttention.current.delete(key);
    const acknowledge = window.ogb?.terminal?.acknowledge;
    if (acknowledge) void acknowledge(attention.sessionId).catch(() => {});
    dispatch({ type: "ackTerminalAttention", botId: attention.botId, sessionId: attention.sessionId });
  };
  const requestTerminalAcknowledgement = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId) ?? new Set<string>();
    sessions.add(attention.sessionId);
    pendingTerminalAcknowledgements.current.set(attention.botId, sessions);
    if (terminalOpen && bot?.id === attention.botId && document.hasFocus()) acknowledgeTerminalAttention(attention);
  };
  const openTerminalNotification = (target: NotificationTarget) => {
    if (target.openTerminal) {
      setBrowserWorkspaceBotId(null);
      setLocalVmWorkspaceBotId(null);
      dispatch({ type: "toggleComputer", open: false });
    }
    openNotificationTarget(dispatch, target, latestState.current);
    if (target.openTerminal) setTerminalViews((views) => ({ ...views, [target.botId]: true }));
    if (target.openTerminal) {
      const attention = target.terminalSessionId
        ? { botId: target.botId, sessionId: target.terminalSessionId }
        : terminalAttentionForBot(latestState.current.terminalAttention, target.botId);
      if (attention) requestTerminalAcknowledgement(attention);
    }
  };
  const openTerminalAttention = (attention: TerminalAttention) => {
    const current = latestState.current;
    const target = current.bots.find((candidate) => candidate.id === attention.botId);
    if (!target) {
      acknowledgeTerminalAttention(attention);
      return;
    }
    setBrowserWorkspaceBotId(null);
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: false });
    openNotificationTarget(
      dispatch,
      { botId: attention.botId, threadId: target.threadId, openTerminal: true },
      current,
    );
    setTerminalViews((views) => ({ ...views, [attention.botId]: true }));
    requestTerminalAcknowledgement(attention);
  };

  useEffect(() => {
    const acknowledgeVisible = () => {
      if (!terminalOpen || !bot || !document.hasFocus()) return;
      const targeted = pendingTerminalAcknowledgements.current.get(bot.id);
      if (targeted) {
        for (const sessionId of [...targeted]) {
          const attention = state.terminalAttention[terminalAttentionKey(bot.id, sessionId)];
          if (attention) acknowledgeTerminalAttention(attention);
          else targeted.delete(sessionId);
        }
        if (targeted.size === 0) pendingTerminalAcknowledgements.current.delete(bot.id);
        return;
      }
      const attention = terminalAttentionForBot(state.terminalAttention, bot.id);
      if (attention) acknowledgeTerminalAttention(attention);
    };
    acknowledgeVisible();
    window.addEventListener("focus", acknowledgeVisible);
    return () => window.removeEventListener("focus", acknowledgeVisible);
  }, [bot?.id, state.terminalAttention, terminalOpen, dispatch]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count: that CLI can still host a local model. An empty list means the
  // first /api/instances response has not arrived yet.
  const noEngines = state.connected && isEmptyEngineLaunch(state.instances);

  // App-wide shortcuts: Alt+T Themes · Alt+U Usage · Ctrl+1..9 Nth bot · Alt+1..9 Nth pane while the terminal is open, else Nth bot. Esc still closes panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey) {
        if (e.code === "KeyT") {
          e.preventDefault();
          dispatch({
            type: "toggleAppSettings",
            open: !(state.appSettingsOpen && state.appSettingsSection === "themes"),
            section: "themes",
          });
          return;
        }
        if (e.code === "KeyU") {
          e.preventDefault();
          dispatch({
            type: "toggleAppSettings",
            open: !(state.appSettingsOpen && state.appSettingsSection === "usage"),
            section: "usage",
          });
          return;
        }
      }
      if (!e.shiftKey && ((e.altKey && !mod) || (e.ctrlKey && !e.metaKey && !e.altKey))) {
        const n: number | null =
          e.code === "Digit1" || e.code === "Numpad1" ? 1
          : e.code === "Digit2" || e.code === "Numpad2" ? 2
          : e.code === "Digit3" || e.code === "Numpad3" ? 3
          : e.code === "Digit4" || e.code === "Numpad4" ? 4
          : e.code === "Digit5" || e.code === "Numpad5" ? 5
          : e.code === "Digit6" || e.code === "Numpad6" ? 6
          : e.code === "Digit7" || e.code === "Numpad7" ? 7
          : e.code === "Digit8" || e.code === "Numpad8" ? 8
          : e.code === "Digit9" || e.code === "Numpad9" ? 9
          : null;
        // only the desktop workspace has panes to pick; remote keeps bot switching
        if (n !== null && e.altKey && terminalOpen && window.ogb?.terminal) {
          e.preventDefault();
          e.stopPropagation();
          setPaneHotkey({ n });
          return;
        }
        if (n !== null) {
          const rows = document.querySelectorAll('[data-sidebar-row-kind="bot"]');
          const id = rows[n - 1]?.getAttribute("data-sidebar-row-id");
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "select", id });
          focusComposerOnActivation({ settingsOpen: state.appSettingsOpen || state.settingsOpen });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state.appSettingsOpen, state.appSettingsSection, state.settingsOpen, terminalOpen, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    const offAttention = window.ogb?.terminal?.onAttention?.(({ id: sessionId, botId, reason }) => {
      const current = latestState.current;
      const bot = current.bots.find((candidate) => candidate.id === botId);
      if (!bot) return;
      const key = terminalAttentionKey(botId, sessionId);
      if (handledTerminalAttention.current.has(key) || current.terminalAttention[key]) return;
      handledTerminalAttention.current.add(key);
      dispatch({ type: "markTerminalAttention", botId, sessionId, reason, receivedAt: Date.now() });
      const frame = buildTerminalNotification(bot, reason, sessionId);
      if (!frame) return;
      showNotification(
        frame,
        openTerminalNotification,
        bot.avatarUrl,
        terminalOpen && current.selectedId === botId ? visibleNotificationThread(current) : null,
      );
    });
    return offAttention;
  }, [dispatch, terminalOpen]);

  useEffect(() => {
    return window.ogb?.onNotificationClick?.((target) => {
      const current = latestState.current;
      openNotificationTarget(dispatch, target, current);
      if (target.openTerminal) {
        setBrowserWorkspaceBotId(null);
        setLocalVmWorkspaceBotId(null);
        dispatch({ type: "toggleComputer", open: false });
        setTerminalViews((views) => ({ ...views, [target.botId]: true }));
        const attention = target.terminalSessionId
          ? { botId: target.botId, sessionId: target.terminalSessionId }
          : terminalAttentionForBot(current.terminalAttention, target.botId);
        if (attention) requestTerminalAcknowledgement(attention);
      } else {
        // A chat toast must not inherit the bot's last terminal view.
        setTerminalViews((views) => ({ ...views, [target.botId]: false }));
      }
    });
  }, [dispatch]);

  const taskbarBusy = state.bots.some((candidate) => candidate.busy);
  useEffect(() => {
    window.ogb?.setTaskbarBusy?.(taskbarBusy);
  }, [taskbarBusy]);

  // Warm connected-account state after first paint. The catalog is not on
  // the chat path; pulling PluginsPanel into the initial module graph (or
  // hitting /api/connectors/connected during hydrate) delays the composer.
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    const wake = () => {
      if (cancelled) return;
      void import("@/components/PluginsPanel")
        .then((m) => m.preloadConnectedApps())
        .catch(() => {});
    };
    const idle = window.requestIdleCallback?.(wake, { timeout: 800 });
    const timer = idle == null ? window.setTimeout(wake, 1) : 0;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };
  const openBrowserWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  };
  const closeBrowserWorkspace = () => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  };
  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

  // the workspace paints before a passive effect would run, and an unread frame
  // landing in that gap would clear a badge for a chat nobody can see
  useLayoutEffect(() => {
    dispatch({ type: "setWorkspaceOpen", open: Boolean(browserWorkspaceBotId || localVmWorkspaceBotId || terminalOpen) });
  }, [browserWorkspaceBotId, localVmWorkspaceBotId, terminalOpen, dispatch]);

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen ||
    state.createBotOpen;

  const closeTerminal = () => {
    if (bot) setTerminalViews((views) => ({ ...views, [bot.id]: false }));
    requestAnimationFrame(() => conversationRef.current?.querySelector<HTMLTextAreaElement>("[data-orbit-composer]")?.focus());
  };

  const backNavigation = useRef<BackNavigation | null>(null);
  const selectionTrail = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (window.ogb) return;
    const navigation = new BackNavigation(window.history);
    backNavigation.current = navigation;
    const onPop = () => navigation.pop();
    const onPicker = (event: Event) => {
      const { id, open } = (event as CustomEvent<{ id: string; open: boolean }>).detail;
      if (open) modelPickerIds.current.add(id);
      else modelPickerIds.current.delete(id);
      setModelPickerOpen(modelPickerIds.current.size > 0);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("orbit:model-picker", onPicker);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("orbit:model-picker", onPicker);
      backNavigation.current = null;
    };
  }, []);

  useEffect(() => {
    if (!backNavigation.current || !state.bots.length) return;
    const root = state.bots.find((candidate) => candidate.chiefOfStaff)?.id ?? state.bots[0].id;
    const trail = selectionTrail.current;
    if (!trail.length) trail.push(root);
    if (state.selectedId && trail.at(-1) !== state.selectedId) {
      const previous = trail.indexOf(state.selectedId);
      if (previous >= 0) trail.splice(previous + 1);
      else trail.push(state.selectedId);
    }
    const layers: BackLayer[] = trail.slice(1).map((id, index) => ({
      key: `chat:${id}`,
      close: () => dispatch({ type: "select", id: trail[index] }),
    }));
    const add = (open: boolean, key: string, close: () => void) => { if (open) layers.push({ key, close }); };
    add(state.activeView !== "chat", `view:${state.activeView}`, () => dispatch({ type: "select", id: state.selectedId }));
    add(Boolean(browserWorkspaceBotId), `browser:${browserWorkspaceBotId}`, () => setBrowserWorkspaceBotId(null));
    add(Boolean(localVmWorkspaceBotId), `vm:${localVmWorkspaceBotId}`, () => setLocalVmWorkspaceBotId(null));
    add(terminalOpen, `terminal:${bot?.id}`, closeTerminal);
    add(drawerOpen, "drawer", () => setDrawerOpen(false));
    add(Boolean(sidebarOverlay), `sidebar:${sidebarOverlay}`, () => window.dispatchEvent(new Event("orbit:close-sidebar-overlay")));
    add(state.settingsOpen, "settings", () => dispatch({ type: "toggleSettings", open: false }));
    add(state.computerOpen, "computer", () => dispatch({ type: "toggleComputer", open: false }));
    add(state.inspectorOpen, "inspector", () => dispatch({ type: "toggleInspector", open: false }));
    add(state.appSettingsOpen, "app-settings", () => dispatch({ type: "toggleAppSettings", open: false }));
    add(state.pluginsOpen, "plugins", () => dispatch({ type: "togglePlugins", open: false }));
    add(state.createBotOpen, "create-bot", () => dispatch({ type: "closeCreateBot" }));
    add(paletteOpen, "palette", () => window.dispatchEvent(new Event("orbit:close-palette")));
    add(modelPickerOpen, "model-picker", () => window.dispatchEvent(new Event("orbit:close-model-picker")));
    backNavigation.current.sync(layers);
  });

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "Backquote") return;
      if (!window.ogb?.terminal || !bot || group || state.activeView !== "chat" || nativeViewOverlayOpen || browserWorkspaceBotId || localVmWorkspaceBotId) return;
      event.preventDefault();
      event.stopPropagation();
      if (terminalOpen) closeTerminal();
      else openTerminal();
    };
    window.addEventListener("keydown", toggleTerminal, true);
    return () => window.removeEventListener("keydown", toggleTerminal, true);
  }, [bot?.id, group?.id, state.activeView, nativeViewOverlayOpen, browserWorkspaceBotId, localVmWorkspaceBotId, terminalOpen]);

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  return (
    <div className="flex h-full flex-col">
      {/* Windows titleBarOverlay drag strip; height reserved via body padding. */}
      {typeof window !== "undefined" && window.ogb?.platform === "win32" ? (
        <div className="orbit-windows-caption" aria-hidden />
      ) : null}
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label={t("chrome.openBotList")}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        onOverlayChange={setSidebarOverlay}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
        onTerminalAttention={openTerminalAttention}
      />
      {state.activeView === "team-map" ? (
        <Suspense fallback={<BootFallback />}>
          <TeamMapPage />
        </Suspense>
      ) : state.activeView === "routines" ? (
        <Suspense fallback={<BootFallback />}>
          <RoutinesPage />
        </Suspense>
      ) : state.activeView === "skill-recorder" ? (
        <Suspense fallback={<BootFallback />}>
          <SkillRecorderPage />
        </Suspense>
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <Suspense fallback={<BootFallback />}>
          <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
        </Suspense>
      ) : localVmWorkspaceBotId ? (
        <Suspense fallback={<BootFallback />}>
          <LocalVmWorkspace
            primaryBotId={localVmWorkspaceBotId}
            overlayOpen={nativeViewOverlayOpen}
            onClose={() => setLocalVmWorkspaceBotId(null)}
            onOpenComputer={openComputerFromWorkspace}
          />
        </Suspense>
      ) : noEngines ? (
        <Suspense fallback={<BootFallback />}>
          <NoEngines />
        </Suspense>
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <div ref={conversationRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1" inert={terminalOpen} aria-hidden={terminalOpen}>
            <ChatView
              bot={bot}
              focusComposerBlocked={paletteOpen || terminalOpen}
              onOpenTerminal={openTerminal}
            />
          </div>
          {terminalViews[bot.id] !== undefined && (
            <div className="orbit-terminal-overlay absolute inset-0 z-20 flex" data-open={terminalOpen} inert={!terminalOpen} aria-hidden={!terminalOpen}>
              <Suspense fallback={<BootFallback label={t("terminal.connecting")} />}>
                {window.ogb?.terminal ? (
                  <TerminalWorkspace key={bot.id} bot={bot} visible={terminalOpen} focusBlocked={nativeViewOverlayOpen} paneHotkey={paneHotkey} onClose={closeTerminal} />
                ) : (
                  <RemoteTerminalView key={bot.id} bot={bot} visible={terminalOpen} onClose={closeTerminal} />
                )}
              </Suspense>
            </div>
          )}
        </div>
      ) : (
        <BootFallback
          label={state.connected ? t("chrome.noBots") : t("chrome.connecting")}
          hint={
            !state.connected ? (
              <>
                {t("chrome.startServerHint")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
              </>
            ) : undefined
          }
        />
      )}
      {state.settingsOpen && bot && (
        <Suspense fallback={null}>
          <SettingsPanel key={bot.id} bot={bot} />
        </Suspense>
      )}
      {showComputerPanelChrome() && state.computerOpen && bot && (
        <Suspense fallback={null}>
          <ComputerPanel bot={bot} onOpenVmWorkspace={openLocalVmWorkspace} onExpandBrowser={openBrowserWorkspace} />
        </Suspense>
      )}
      {state.inspectorOpen && bot && (
        <Suspense fallback={null}>
          <InspectorPanel bot={bot} />
        </Suspense>
      )}
      {state.appSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      {state.pluginsOpen && (
        <Suspense fallback={null}>
          <PluginsPanel />
        </Suspense>
      )}
      {!onboardingOpen && !noEngines && state.connected && (state.createBotOpen || state.bots.length === 0) && (
        <Suspense fallback={null}>
          <CreateBotSheet required={state.bots.length === 0} />
        </Suspense>
      )}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <Suspense fallback={null}>
        <CommandPalette onOpenChange={setPaletteOpen} />
      </Suspense>
      </div>
    </div>
  );
}

const ONBOARDING_DONE_KEY = "omb-onboarding-done";

function onboardingDone(): boolean {
  try {
    return Boolean(localStorage.getItem(ONBOARDING_DONE_KEY) || localStorage.getItem("omb-email-gate"));
  } catch {
    return false;
  }
}

function setOnboardingDone() {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true");
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [onboardingOpen, setOnboardingOpen] = useState(() => !onboardingDone());
  return (
    <I18nProvider>
      <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell onboardingOpen={onboardingOpen} />
        {onboardingOpen && (
          <Suspense fallback={<div className="orbit-inset-aware fixed inset-0 z-50 bg-app" />}>
            <Onboarding
              onDone={() => {
                setOnboardingDone();
                setOnboardingOpen(false);
              }}
            />
          </Suspense>
        )}
      </StoreProvider>
      </DesktopCapabilitiesProvider>
    </I18nProvider>
  );
}
