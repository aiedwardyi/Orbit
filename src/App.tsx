import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { collapsedUnreadCount, formatCollapsedUnreadBadge, unreadConversationCount } from "@/lib/unread";
import { anyChatNeedsYou } from "@/lib/open-question";
import { preferredStartupSelectionId } from "@/lib/sidebar-order";
import { DRAWER_BUTTON_LEFT, DRAWER_BUTTON_RIGHT } from "@/lib/drawer-button";
import { loadSidebarOrder, useSidebarSide } from "@/lib/sidebar-preferences";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { LazyView } from "@/components/LazyView";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { showComputerPanelChrome } from "@/lib/friends-chrome";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { buildTerminalNotification, showNotification, type NotificationTarget } from "@/lib/notify";
import { terminalPopupsEnabled } from "@/lib/terminal-popups";
import { altDigitSelectsPane, backquoteTogglesTerminal } from "@/lib/terminal-hotkeys";
import { useTerminalPanes } from "@/lib/terminal-panes";
import { rememberTerminalOpened, schedulePrestart } from "@/lib/terminal-prestart";
import { composerNeedsTap, focusComposerOnActivation } from "@/lib/focus-composer";
import { webPushTarget } from "@/lib/web-push";
import { useDrawerSwipe, usePhoneSwipe } from "@/lib/use-phone-swipe";
import { BackNavigation, backDepth, followSelection, trailTarget, type BackLayer } from "@/lib/back-navigation";
import { SKINS, applySkin, nextSkin, readSkin, type SkinId } from "@/lib/skins";
import { Presence } from "@/lib/use-presence";
import { lazyView, useStaleBuildReload } from "@/lib/stale-build";
import { markColdOpen, noteChatShown, startWarmOpenTiming } from "@/lib/cold-open-timing";

const Onboarding = lazyView(() => import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })));
const SettingsPanel = lazyView(() => import("@/components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const PluginsPanel = lazyView(() => import("@/components/PluginsPanel").then((m) => ({ default: m.PluginsPanel })));
const ComputerPanel = lazyView(() => import("@/components/ComputerPanel").then((m) => ({ default: m.ComputerPanel })));
const InspectorPanel = lazyView(() => import("@/components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })));
const SettingsModal = lazyView(() => import("@/components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const RoutinesPage = lazyView(() => import("@/components/RoutinesPage").then((m) => ({ default: m.RoutinesPage })));
const NoEngines = lazyView(() => import("@/components/NoEngines").then((m) => ({ default: m.NoEngines })));
const CommandPalette = lazyView(() => import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const LocalVmWorkspace = lazyView(() => import("@/components/LocalVmWorkspace").then((m) => ({ default: m.LocalVmWorkspace })));
const BrowserWorkspace = lazyView(() => import("@/components/BrowserWorkspace").then((m) => ({ default: m.BrowserWorkspace })));
const SkillRecorderPage = lazyView(() => import("@/components/SkillRecorderPage").then((m) => ({ default: m.SkillRecorderPage })));
const TeamMapPage = lazyView(() => import("@/components/TeamMapPage").then((m) => ({ default: m.TeamMapPage })));
const CreateBotSheet = lazyView(() => import("@/components/CreateBotSheet").then((m) => ({ default: m.CreateBotSheet })));
const TerminalWorkspace = lazyView(() => import("@/components/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace })));
const RemoteTerminalView = lazyView(() => import("@/components/RemoteTerminalView").then((m) => ({ default: m.RemoteTerminalView })));

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
  const menuUnreadBadge = formatCollapsedUnreadBadge(collapsedUnreadCount(state.bots, state.groups, state.selectedId));
  const menuAsking = anyChatNeedsYou([...state.bots, ...state.groups], state.selectedId);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [themeToast, setThemeToast] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [sidebarOverlay, setSidebarOverlay] = useState<string | null>(null);
  const modelPickerIds = useRef(new Set<string>());
  const [terminalViews, setTerminalViews] = useState<Record<string, boolean>>({});
  const [paneHotkey, setPaneHotkey] = useState<{ n: number } | null>(null);
  const [paneFocus, setPaneFocus] = useState<{ sessionId: string } | null>(null);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarOnRight = useSidebarSide() === "right";
  const conversationRef = useRef<HTMLDivElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? fallbackStartupBot(state.bots, state.groups));
  const terminalOpen = Boolean(bot && terminalViews[bot.id] && state.activeView === "chat" && !browserWorkspaceBotId && !localVmWorkspaceBotId);
  const openTerminal = () => { if (bot) setTerminalViews((views) => ({ ...views, [bot.id]: true })); };
  const closeWorkspaces = () => {
    setBrowserWorkspaceBotId(null);
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: false });
  };
  const openTerminalPane = (sessionId: string) => {
    closeWorkspaces();
    openTerminal();
    setPaneFocus({ sessionId });
  };
  const clearTerminalAttention = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const key = terminalAttentionKey(attention.botId, attention.sessionId);
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId);
    sessions?.delete(attention.sessionId);
    if (sessions?.size === 0) pendingTerminalAcknowledgements.current.delete(attention.botId);
    handledTerminalAttention.current.delete(key);
    dispatch({ type: "ackTerminalAttention", botId: attention.botId, sessionId: attention.sessionId });
  };
  const acknowledgeTerminalAttention = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    clearTerminalAttention(attention);
    const acknowledge = window.ogb?.terminal?.acknowledge;
    if (acknowledge) void acknowledge(attention.sessionId).catch(() => {});
  };
  const requestTerminalAcknowledgement = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId) ?? new Set<string>();
    sessions.add(attention.sessionId);
    pendingTerminalAcknowledgements.current.set(attention.botId, sessions);
    if (terminalOpen && bot?.id === attention.botId && document.hasFocus()) acknowledgeTerminalAttention(attention);
  };
  const openTerminalNotification = (target: NotificationTarget) => {
    if (target.openTerminal) closeWorkspaces();
    openNotificationTarget(dispatch, target, latestState.current);
    if (target.openTerminal) setTerminalViews((views) => ({ ...views, [target.botId]: true }));
    if (target.openTerminal && target.terminalSessionId) setPaneFocus({ sessionId: target.terminalSessionId });
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
    setPaneFocus({ sessionId: attention.sessionId });
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

  // App-wide shortcuts: Alt+T Themes · Alt+Shift+T Cycle theme · Alt+U Usage · Alt+I Model index · Ctrl+1..9 Nth bot · Alt+1..9 Nth pane while the terminal is open, else Nth bot. Esc still closes panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey && e.code === "KeyI") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({
          type: "toggleAppSettings",
          open: !(state.appSettingsOpen && state.appSettingsSection === "models-index"),
          section: "models-index",
        });
        return;
      }
      if (e.altKey && !mod && e.shiftKey && e.code === "KeyT") {
        if (e.repeat || e.isComposing) return;
        e.preventDefault();
        const current = (document.documentElement.dataset.skin as SkinId) || readSkin();
        const next = nextSkin(current);
        applySkin(next);
        setThemeToast(SKINS.find((skin) => skin.id === next)?.name ?? next);
        return;
      }
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
        // Desktop picks a preload pane. A window with no preload picks a remote pane. Ctrl+digit still switches bots.
        if (n !== null && e.altKey && terminalOpen && altDigitSelectsPane(Boolean(window.ogb?.terminal), !window.ogb)) {
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
    if (!themeToast) return;
    const timer = window.setTimeout(() => setThemeToast(null), 1200);
    return () => window.clearTimeout(timer);
  }, [themeToast]);

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
      if (!terminalPopupsEnabled()) return;
      const frame = buildTerminalNotification(bot, reason, sessionId);
      if (!frame) return;
      showNotification(
        frame,
        openTerminalNotification,
        terminalOpen && current.selectedId === botId ? visibleNotificationThread(current) : null,
      );
    });
    return offAttention;
  }, [dispatch, terminalOpen]);

  useEffect(() => {
    const offClosed = window.ogb?.terminal?.onClosed?.(({ id: sessionId, botId }) => {
      const current = latestState.current;
      if (!current.terminalAttention[terminalAttentionKey(botId, sessionId)]) return;
      clearTerminalAttention({ botId, sessionId });
    });
    return offClosed;
  }, [dispatch]);

  useTerminalPanes(dispatch, terminalOpen);

  useEffect(() => {
    return window.ogb?.onNotificationClick?.((target) => {
      const current = latestState.current;
      openNotificationTarget(dispatch, target, current);
      if (target.openTerminal) {
        setBrowserWorkspaceBotId(null);
        setLocalVmWorkspaceBotId(null);
        dispatch({ type: "toggleComputer", open: false });
        setTerminalViews((views) => ({ ...views, [target.botId]: true }));
        if (target.terminalSessionId) setPaneFocus({ sessionId: target.terminalSessionId });
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

  // A tapped push notification: its /?bot=&thread= url on a cold open, or a worker message when already open.
  const pushOpenTarget = useRef(webPushTarget(window.location.search));
  const hydratedBots = state.bots.length > 0;
  useEffect(() => {
    const target = pushOpenTarget.current;
    if (!target || !hydratedBots) return;
    pushOpenTarget.current = null;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    openNotificationTarget(dispatch, target, latestState.current, true);
  }, [dispatch, hydratedBots]);
  useEffect(() => {
    const worker = window.ogb ? undefined : navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "orbit-open" || typeof event.data.url !== "string") return;
      const target = webPushTarget(new URL(event.data.url, window.location.origin).search);
      if (!target) return;
      setTerminalViews((views) => ({ ...views, [target.botId]: false }));
      startWarmOpenTiming(Number(event.data.t0), target.threadId);
      openNotificationTarget(dispatch, target, latestState.current);
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [dispatch]);
  const shown = group ?? bot;
  const shownThread = state.hydrated && state.activeView === "chat" && shown?.messages?.length ? shown.threadId : undefined;
  // No deps: a warm tap onto the chat already on screen changes nothing here but still needs its paint time.
  useEffect(() => noteChatShown(shownThread));

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
  // the reducer switches the view without changing selectedId. pluginsOpen,
  // settingsOpen and appSettingsOpen cover the same idea from a different
  // trigger: close the drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen, state.appSettingsOpen]);

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
  const createBotSheetOpen = !onboardingOpen && !noEngines && state.connected && state.hydrated && (state.createBotOpen || state.bots.length === 0);
  const secondaryViewOpen =
    onboardingOpen ||
    state.activeView !== "chat" ||
    terminalOpen ||
    Boolean(browserWorkspaceBotId || localVmWorkspaceBotId) ||
    paletteOpen ||
    Boolean(sidebarOverlay) ||
    state.appSettingsOpen ||
    state.pluginsOpen ||
    createBotSheetOpen ||
    Boolean(bot && (state.settingsOpen || state.inspectorOpen || (showComputerPanelChrome() && state.computerOpen)));
  useStaleBuildReload(state.connected, secondaryViewOpen);

  const swipeStageRef = usePhoneSwipe(bot?.id, !terminalOpen && !nativeViewOverlayOpen, (id) => dispatch({ type: "select", id }));
  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  };
  const drawerShellRef = useDrawerSwipe(drawerOpen && !sidebarOverlay, sidebarOnRight ? "right" : "left", closeDrawer);

  const chatShown = Boolean(bot && state.activeView === "chat" && !terminalOpen);
  useEffect(() => {
    if (bot && terminalOpen) rememberTerminalOpened(bot.id);
  }, [bot?.id, terminalOpen]);
  useEffect(() => {
    if (!bot || !chatShown) return;
    return schedulePrestart({
      bridge: window.ogb?.terminal,
      botId: bot.id,
      projectCwd: bot.cwd ?? null,
      measure: () => conversationRef.current?.getBoundingClientRect(),
    });
  }, [bot?.id, bot?.cwd, chatShown]);

  const closeTerminal = () => {
    if (bot) setTerminalViews((views) => ({ ...views, [bot.id]: false }));
    requestAnimationFrame(() => {
      if (!composerNeedsTap()) conversationRef.current?.querySelector<HTMLTextAreaElement>("[data-orbit-composer]")?.focus();
    });
  };

  const backNavigation = useRef<BackNavigation | null>(null);
  const selectionTrail = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (window.ogb) return;
    const navigation = new BackNavigation(window.history);
    backNavigation.current = navigation;
    const onPop = (event: PopStateEvent) => navigation.pop(backDepth(event.state));
    const onPicker = (event: Event) => {
      const { id, open } = (event as CustomEvent<{ id: string; open: boolean }>).detail;
      if (open) modelPickerIds.current.add(id);
      else modelPickerIds.current.delete(id);
      setModelPickerOpen(modelPickerIds.current.size > 0);
    };
    const onLeave = (event: CustomEvent<string>) => navigation.leave(() => window.location.replace(event.detail));
    window.addEventListener("popstate", onPop);
    window.addEventListener("orbit:model-picker", onPicker);
    window.addEventListener("orbit:leave", onLeave);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("orbit:model-picker", onPicker);
      window.removeEventListener("orbit:leave", onLeave);
      backNavigation.current = null;
    };
  }, []);

  useEffect(() => {
    if (!backNavigation.current || !state.bots.length) return;
    const root = state.bots.find((candidate) => candidate.chiefOfStaff)?.id ?? state.bots[0].id;
    const trail = selectionTrail.current;
    const exists = (id: string) =>
      latestState.current.bots.some((candidate) => candidate.id === id) || latestState.current.groups.some((candidate) => candidate.id === id);
    followSelection(trail, root, state.selectedId, exists);
    const layers: BackLayer[] = trail.slice(1).map((id, index) => ({
      key: `chat:${id}`,
      close: () => {
        const target = trailTarget(trail, index, exists);
        if (target) dispatch({ type: "select", id: target });
      },
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
      if (!backquoteTogglesTerminal(Boolean(window.ogb), Boolean(window.ogb?.terminal)) || !bot || group || state.activeView !== "chat" || nativeViewOverlayOpen || browserWorkspaceBotId || localVmWorkspaceBotId) return;
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
      {themeToast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-hairline/50 bg-card px-3.5 py-1.5 text-[13px] text-ink shadow-xl"
        >
          {themeToast}
        </div>
      )}
      <div ref={drawerShellRef} className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label={menuAsking ? t("ask.openBotList") : t("chrome.openBotList")}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        data-menu-needs-you={menuAsking || undefined}
        className={`absolute z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden ${sidebarOnRight ? DRAWER_BUTTON_RIGHT : DRAWER_BUTTON_LEFT}${menuAsking ? " needs-you-glow" : ""}`}
      >
        <Menu size={18} />
        {menuUnreadBadge != null && (
          <span
            data-menu-unread
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink"
          >
            {menuUnreadBadge}
          </span>
        )}
      </button>
      <div
        aria-hidden
        data-phone-drawer-scrim
        onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
        className={`absolute inset-0 z-30 bg-black/50 transition-opacity duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none md:hidden ${drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />
      <Sidebar
        open={drawerOpen}
        onOverlayChange={setSidebarOverlay}
        onClose={closeDrawer}
        onTerminalAttention={openTerminalAttention}
        rigidView={Boolean(browserWorkspaceBotId || localVmWorkspaceBotId || (bot && terminalViews[bot.id] !== undefined))}
      />
      {state.activeView === "team-map" ? (
        <LazyView fallback={<BootFallback />}>
          <TeamMapPage />
        </LazyView>
      ) : state.activeView === "routines" ? (
        <LazyView fallback={<BootFallback />}>
          <RoutinesPage />
        </LazyView>
      ) : state.activeView === "skill-recorder" ? (
        <LazyView fallback={<BootFallback />}>
          <SkillRecorderPage />
        </LazyView>
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <LazyView fallback={<BootFallback />}>
          <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
        </LazyView>
      ) : localVmWorkspaceBotId ? (
        <LazyView fallback={<BootFallback />}>
          <LocalVmWorkspace
            primaryBotId={localVmWorkspaceBotId}
            overlayOpen={nativeViewOverlayOpen}
            onClose={() => setLocalVmWorkspaceBotId(null)}
            onOpenComputer={openComputerFromWorkspace}
          />
        </LazyView>
      ) : noEngines ? (
        <LazyView fallback={<BootFallback />}>
          <NoEngines />
        </LazyView>
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <div ref={conversationRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
          <div ref={swipeStageRef} className="flex min-h-0 flex-1" inert={terminalOpen} aria-hidden={terminalOpen}>
            <ChatView
              bot={bot}
              focusComposerBlocked={paletteOpen || terminalOpen}
              onOpenTerminal={openTerminal}
              onOpenTerminalPane={openTerminalPane}
            />
          </div>
          {terminalViews[bot.id] !== undefined && (
            <div className="orbit-terminal-overlay absolute inset-0 z-20 flex" data-open={terminalOpen} inert={!terminalOpen} aria-hidden={!terminalOpen}>
              <LazyView fallback={<BootFallback label={t("terminal.connecting")} />}>
                {window.ogb?.terminal ? (
                  <TerminalWorkspace key={bot.id} bot={bot} visible={terminalOpen} focusBlocked={nativeViewOverlayOpen} paneHotkey={paneHotkey} paneFocus={paneFocus} onClose={closeTerminal} />
                ) : (
                  <RemoteTerminalView key={bot.id} bot={bot} visible={terminalOpen} paneHotkey={paneHotkey} onClose={closeTerminal} />
                )}
              </LazyView>
            </div>
          )}
        </div>
      ) : (
        <BootFallback
          label={state.connected && state.hydrated ? t("chrome.noBots") : t("chrome.connecting")}
          hint={
            !state.connected ? (
              <>
                {t("chrome.startServerHint")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
              </>
            ) : undefined
          }
        />
      )}
      <Presence open={Boolean(state.settingsOpen && bot)}>
        {(closing) => bot && (
          <LazyView overlay>
            <SettingsPanel key={bot.id} bot={bot} closing={closing} />
          </LazyView>
        )}
      </Presence>
      {showComputerPanelChrome() && state.computerOpen && bot && (
        <LazyView overlay>
          <ComputerPanel bot={bot} onOpenVmWorkspace={openLocalVmWorkspace} onExpandBrowser={openBrowserWorkspace} />
        </LazyView>
      )}
      {state.inspectorOpen && bot && (
        <LazyView overlay>
          <InspectorPanel bot={bot} />
        </LazyView>
      )}
      <Presence open={state.appSettingsOpen}>
        {(closing) => (
          <LazyView overlay>
            <SettingsModal closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={state.pluginsOpen}>
        {(closing) => (
          <LazyView overlay>
            <PluginsPanel closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={createBotSheetOpen}>
        {(closing) => (
          <LazyView overlay>
            <CreateBotSheet required={state.bots.length === 0} closing={closing} />
          </LazyView>
        )}
      </Presence>
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <LazyView overlay>
        <CommandPalette onOpenChange={setPaletteOpen} />
      </LazyView>
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
  useEffect(() => markColdOpen("mount"), []);
  return (
    <I18nProvider>
      <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell onboardingOpen={onboardingOpen} />
        {onboardingOpen && (
          <LazyView overlay fallback={<div className="orbit-inset-aware fixed inset-0 z-50 bg-app" />}>
            <Onboarding
              onDone={() => {
                setOnboardingDone();
                setOnboardingOpen(false);
              }}
            />
          </LazyView>
        )}
      </StoreProvider>
      </DesktopCapabilitiesProvider>
    </I18nProvider>
  );
}
