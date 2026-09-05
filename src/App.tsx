import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Menu } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { showComputerPanelChrome } from "@/lib/friends-chrome";
import { I18nProvider, useI18n } from "@/lib/i18n";

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

function Shell({ onboardingOpen }: { onboardingOpen: boolean }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteReady, setPaletteReady] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count: that CLI can still host a local model. An empty list means the
  // first /api/instances response has not arrived yet.
  const noEngines = state.connected && isEmptyEngineLaunch(state.instances);

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  const taskbarBusy = state.bots.some((candidate) => candidate.busy);
  useEffect(() => {
    window.ogb?.setTaskbarBusy?.(taskbarBusy);
  }, [taskbarBusy]);

  useEffect(() => {
    const wake = () => setPaletteReady(true);
    const idle = window.requestIdleCallback?.(wake, { timeout: 800 });
    const timer = idle == null ? window.setTimeout(wake, 1) : 0;
    return () => {
      if (idle != null) window.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

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
    dispatch({ type: "setWorkspaceOpen", open: Boolean(browserWorkspaceBotId || localVmWorkspaceBotId) });
  }, [browserWorkspaceBotId, localVmWorkspaceBotId, dispatch]);

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
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
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
        <ChatView bot={bot} focusComposerBlocked={paletteOpen} />
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
      {paletteReady && (
        <Suspense fallback={null}>
          <CommandPalette onOpenChange={setPaletteOpen} />
        </Suspense>
      )}
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <I18nProvider>
      <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell onboardingOpen={gated} />
        {gated && (
          <Suspense fallback={<div className="fixed inset-0 z-50 bg-app" />}>
            <Onboarding onDone={() => setGated(false)} />
          </Suspense>
        )}
      </StoreProvider>
      </DesktopCapabilitiesProvider>
    </I18nProvider>
  );
}
