import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crown, Loader2, Pin, Users, X } from "lucide-react";
import { roomConversationPreview } from "@/lib/conversation-preview";
import { api, terminalAttentionForBot, useStore, formatTime, previewMessages, shownModelSelection, type Bot, type Group, type TerminalAttention } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { modelChipText, modelFamilyAccent } from "@/lib/model-chip";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { isShownMessage } from "@/lib/shown-message";
import { RenameTitle } from "./RenameTitle";
import { KeepGoingMark, keepGoingMarkState } from "./KeepGoingMark";
import { type SidebarDensity } from "@/lib/sidebar-preferences";
import { sidebarPriorityFor } from "@/lib/sidebar-order";
import { sidebarConversationRowTone } from "@/lib/sidebar-row";
import { chatNeedsYou } from "@/lib/open-question";
import { routineRinging } from "@/lib/routine-ring";
import { useArrivalGlow } from "@/lib/arrival-glow";
import { localeTag, useI18n } from "@/lib/i18n";
import { terminalAttentionCopy } from "@/lib/notify";

export function compactSidebarModelLabel(label: string): string {
  return label.replace(/\s+Contributor$/i, " Cont.");
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

/** Room avatar: 2–3 overlapping mauses in the same 48px slot a bot gets. */
function StackedMauses({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-8" : "size-12";
  const singleSize = iconOnly ? 44 : density === "compact" ? 32 : 48;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div
      data-sidebar-group-avatar-slot
      className={cn("flex shrink-0 items-center justify-center", slotSize, extra > 0 && "min-w-[84px]")}
    >
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={30} animated={false} />
        ))}
        {extra > 0 && (
          <span
            data-sidebar-group-overflow
            className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary"
          >
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({
  group,
  density,
  onMenu,
  drag,
  onReselect,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
  drag?: SidebarRowDrag;
  onReselect?: () => void;
}) {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.filter(isShownMessage).at(-1);
  const question = chatNeedsYou(group.messages);
  const asking = question || routineRinging(state.routineRuns, group.threadId, group.tasks);
  const unreadRing = Boolean(group.unread) && !asking;
  const arrival = useArrivalGlow([group.id], { enabled: !selected, asking });
  const select = () => {
    if (selected) onReselect?.();
    dispatch({ type: "select", id: group.id });
  };
  const dragProps = drag
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.effectAllowed = "move";
          // a custom type: text fields ignore it, so the row never drops in as text
          event.dataTransfer.setData("application/x-orbit-group", group.id);
          drag.onStart();
        },
        onDragOver: (event: React.DragEvent) => {
          if (!drag.onOver()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (event: React.DragEvent) => {
          if (!drag.onOver()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDragLeave: (event: React.DragEvent) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) drag.onLeave();
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          drag.onDrop();
        },
        onDragEnd: drag.onEnd,
      }
    : {};
  // Native drag lives on a plain wrapper div, exactly like BotListItem: the
  // draggable element is never the button itself, so press-then-move from
  // anywhere on the row (avatar, name, preview) initiates the row drag.
  return (
    <div
      className="group relative min-h-12 py-0.5"
      data-sidebar-row
      data-sidebar-row-kind="group"
      data-sidebar-row-id={group.id}
      data-sidebar-needs-you={asking || undefined}
      data-sidebar-chat-unread={group.unread || undefined}
      title={density === "icons" ? group.name : undefined}
      {...dragProps}
    >
      {drag?.edge && (
        <span
          data-sidebar-row-drop-marker
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent",
            drag.edge === "top" ? "-top-0.5" : "-bottom-0.5",
          )}
        />
      )}
      <button
        type="button"
        onClick={(e) => {
          select();
          focusComposerOnActivation({
            activatedElement: e.currentTarget,
            settingsOpen: state.settingsOpen || state.appSettingsOpen,
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
        }}
        // the menu must be reachable without a pointer: Shift+F10, and the
        // dedicated ContextMenu key (whose native event carries no useful
        // coordinates) both open it centered on the row
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            drag?.onMove?.(e.key === "ArrowUp" ? -1 : 1);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            select();
            focusComposerOnActivation({
              activatedElement: e.currentTarget,
              settingsOpen: state.settingsOpen || state.appSettingsOpen,
            });
            return;
          }
          if (e.key === " ") {
            e.preventDefault();
            select();
            return;
          }
          if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}
        className={cn(
          "flex w-full items-center rounded-xl text-left",
          density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-2 px-2 py-1.5" : "gap-2 px-3 py-1.5",
          selected ? "bg-raised" : "hover:bg-raised/50",
          asking && "relative needs-you-glow",
          unreadRing && "relative unread-ring",
          arrival.playing && "relative arrival-glow",
        )}
        data-arrival-glow={arrival.playing || undefined}
        onAnimationEnd={arrival.onAnimationEnd}
        aria-label={density === "icons" ? (asking ? t(question ? "ask.rowHasQuestion" : "routine.rowRang", { name: group.name }) : group.name) : undefined}
        aria-keyshortcuts={drag?.onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      >
        <StackedMauses members={members} density={density} />
        <div className={cn("@container/rowtext min-w-0 flex-1", density === "icons" && "hidden")}>
          <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
              {group.name}
              <span className="sr-only" aria-live="polite">{asking ? t(question ? "ask.hasQuestionSuffix" : "routine.rangSuffix") : ""}</span>
            </span>
            {last && (
              <span
                className={cn(
                  "shrink-0 text-xs text-ink-secondary @max-[10rem]/rowtext:hidden!",
                  !selected && "hidden group-hover:inline group-focus-within:inline",
                )}
              >
                {formatTime(last.at, localeTag(locale))}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "truncate text-ink-secondary",
                density === "compact" ? "text-xs leading-tight" : "text-[13px]",
              )}
            >
              {roomConversationPreview(group, state.bots, showToolCalls)}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

type SidebarRowDrag = {
  edge: "top" | "bottom" | null;
  onStart: () => void;
  onOver: () => boolean;
  onLeave: () => void;
  onDrop: () => void;
  onEnd: () => void;
  onMove?: (direction: -1 | 1) => void;
};

function BotListItem({
  bot,
  density: listDensity,
  onMenu,
  drag,
  onTerminalAttention,
  onReselect,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  drag?: SidebarRowDrag;
  onTerminalAttention?: (attention: TerminalAttention) => void;
  /** Tapping the row whose chat is already open changes no state, so the phone drawer closes here. */
  onReselect?: () => void;
}) {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const density: SidebarDensity = listDensity === "comfortable" && !sidebarPriorityFor(bot) ? "compact" : listDensity;
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? 32 : 48;
  // the visible branch, so a version switch changes the row with the chat
  const visible = previewMessages(bot);
  const last = visible.filter(isShownMessage).at(-1);
  const shownModel = bot.modelSelection && shownModelSelection(bot);
  const engine = state.instances.find((instance) => instance.instanceId === shownModel?.instanceId);
  const modelLabel = engine && shownModel
    ? modelChipText({ instance: engine, model: shownModel.model, effort: shownModel.effort }, t)
    : null;
  const expandedModelLabel = modelLabel ? compactSidebarModelLabel(modelLabel) : null;
  const terminalAttention = terminalAttentionForBot(state.terminalAttention, bot.id);
  const terminalCopy = terminalAttention ? terminalAttentionCopy(terminalAttention.reason, locale) : null;
  const paneLabels = state.terminalPanes[bot.id] ?? [];
  const workerPanes = paneLabels.length;
  const workerPanesLabel = workerPanes
    ? t(workerPanes === 1 ? "chrome.workerPanesOne" : "chrome.workerPanesMany", { count: workerPanes })
    : null;
  const workerPanesTitle = workerPanesLabel && [workerPanesLabel, ...paneLabels.filter(Boolean)].join("\n");
  const question = chatNeedsYou(bot.messages);
  const asking = question || routineRinging(state.routineRuns, bot.threadId, bot.tasks);
  const unreadRing = Boolean(bot.unread) && !asking;
  const keepGoing = keepGoingMarkState(bot);
  const keepGoingLabel = keepGoing ? t(keepGoing === "on" ? "bot.keepGoingOnMark" : "bot.keepGoingPausedMark") : undefined;
  const arrival = useArrivalGlow([bot.id], { enabled: !selected, asking });
  const rowClass = cn(
    "flex w-full items-center rounded-xl border text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1 pr-10"
        : "gap-2 px-3 py-1.5 pr-12",
    sidebarConversationRowTone(selected),
    asking && "relative needs-you-glow",
    unreadRing && "relative unread-ring",
    arrival.playing && "relative arrival-glow",
  );
  const iconLabel = [bot.name, modelLabel, keepGoingLabel].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className={cn("relative shrink-0", iconOnly && "inline-flex")}>
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={avatarSize}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          // Motion means something is happening. A resting bot holds a resting
          // pose - N idle rows bobbing at display rate was most of the app's
          // visible-idle CPU (states are keyword-derived, so "working" can be
          // decorative; busy/unread/motion are the real signals).
          animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {shownModel && (
          <span
            data-sidebar-model-dot
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute size-1.5 rounded-full",
              "bottom-0.5 left-0.5",
              selected ? "ring-2 ring-raised" : "ring-2 ring-panel",
            )}
            style={{ backgroundColor: modelFamilyAccent(engine?.driverKind) }}
          />
        )}
        {keepGoing && (
          <span
            data-sidebar-keep-going={keepGoing}
            role="img"
            aria-label={keepGoingLabel}
            className={cn(
              "pointer-events-none absolute bottom-0 right-0 rounded-full",
              selected ? "bg-raised ring-2 ring-raised" : "bg-panel ring-2 ring-panel",
            )}
          >
            <KeepGoingMark state={keepGoing} size={avatarSize >= 44 ? 12 : 10} />
          </span>
        )}
        {(terminalCopy || workerPanesLabel) && (
          <span className="absolute -right-1 -top-1 z-10 flex">
            {terminalAttention && terminalCopy ? (
              <button
                type="button"
                data-sidebar-terminal-attention
                data-terminal-session-id={terminalAttention.sessionId}
                data-terminal-reason={terminalAttention.reason}
                aria-label={`${bot.name}: ${[terminalCopy.tooltip, workerPanesLabel].filter(Boolean).join(", ")}`}
                title={[terminalCopy.tooltip, workerPanesTitle].filter(Boolean).join("\n")}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (onTerminalAttention) onTerminalAttention(terminalAttention);
                  else dispatch({ type: "ackTerminalAttention", botId: terminalAttention.botId, sessionId: terminalAttention.sessionId });
                }}
                className="flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm border border-accent/60 bg-panel px-1 font-mono text-[9px] font-bold leading-none shadow-sm hover:bg-accent/10"
              >
                <span aria-hidden="true" className="text-accent">&gt;_</span>
                {workerPanes > 0 && (
                  <span data-sidebar-worker-panes={workerPanes} aria-hidden="true" className="text-ink-secondary">
                    {workerPanes}
                  </span>
                )}
              </button>
            ) : (
              <span
                role="img"
                aria-label={`${bot.name}: ${workerPanesLabel}`}
                title={workerPanesTitle ?? undefined}
                className="flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm border border-hairline/60 bg-panel px-1 font-mono text-[9px] font-bold leading-none text-ink-secondary shadow-sm"
              >
                <span aria-hidden="true">&gt;_</span>
                <span data-sidebar-worker-panes={workerPanes} aria-hidden="true">{workerPanes}</span>
              </span>
            )}
          </span>
        )}
      </span>
      <div
        className={cn(
          "@container/rowtext min-w-0 flex-1",
          iconOnly && "hidden",
          density === "compact" && "group-hover:pr-2 group-focus-within:pr-2 max-md:pr-2",
        )}
      >
        <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 text-ink",
              density === "compact" ? "text-[13px] font-medium" : "text-[15px] font-semibold",
            )}
          >
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              editing={renaming}
              onEditingChange={setRenaming}
              className="min-w-0 flex-1 truncate"
              inputClassName={cn(
                "w-full rounded bg-inset px-1 py-0.5",
                density === "compact" ? "text-[13px] font-medium" : "text-[15px] font-semibold",
              )}
            />
            <span className="sr-only" aria-live="polite">{asking ? t(question ? "ask.hasQuestionSuffix" : "routine.rangSuffix") : ""}</span>
          </span>
          {last && !renaming && (
            <span
              className={cn(
                "shrink-0 text-xs text-ink-secondary @max-[10rem]/rowtext:hidden!",
                !selected && "hidden group-hover:inline group-focus-within:inline",
              )}
            >
              {formatTime(last.at, localeTag(locale))}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {bot.chiefOfStaff && (
              <div data-sidebar-chief-title className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-accent">
                <Crown size={11} /> {t("chrome.chiefOfStaff")}
              </div>
            )}
            {(expandedModelLabel || bot.busy) && (
              <div
                data-sidebar-model-row
                className={cn(
                  "flex min-w-0 items-center gap-1.5 truncate text-ink-secondary",
                  density === "compact" ? "text-xs leading-tight" : "text-[13px]",
                )}
              >
                {expandedModelLabel && <span data-sidebar-model-label className="min-w-0 flex-1 truncate">{expandedModelLabel}</span>}
                {bot.busy && <span className="shrink-0 truncate">{t("chrome.working")}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };
  const select = () => {
    if (selected) onReselect?.();
    dispatch({ type: "select", id: bot.id });
  };

  // Keep the rename <input> out of role="button" - a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div
        className={rowClass}
        onContextMenu={onContextMenu}
        data-arrival-glow={arrival.playing || undefined}
        onAnimationEnd={arrival.onAnimationEnd}
      >
        {body}
      </div>
    );
  }

  const dragProps = drag
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.effectAllowed = "move";
          // a custom type: text fields ignore it, so the row never drops in as text
          event.dataTransfer.setData("application/x-orbit-bot", bot.id);
          drag.onStart();
        },
        onDragOver: (event: React.DragEvent) => {
          if (!drag.onOver()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (event: React.DragEvent) => {
          if (!drag.onOver()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDragLeave: (event: React.DragEvent) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) drag.onLeave();
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          drag.onDrop();
        },
        onDragEnd: drag.onEnd,
      }
    : {};

  return (
    <div
      className="group relative min-h-12 py-0.5"
      data-sidebar-row
      data-sidebar-row-kind="bot"
      data-sidebar-row-id={bot.id}
      data-sidebar-needs-you={asking || undefined}
      data-sidebar-chat-unread={bot.unread || undefined}
      title={iconOnly ? iconLabel : undefined}
      {...dragProps}
    >
      {drag?.edge && (
        <span
          data-sidebar-row-drop-marker
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent",
            drag.edge === "top" ? "-top-0.5" : "-bottom-0.5",
          )}
        />
      )}
      <div
        role="button"
        tabIndex={0}
        aria-label={iconOnly ? (asking ? t(question ? "ask.rowHasQuestion" : "routine.rowRang", { name: iconLabel }) : iconLabel) : undefined}
        aria-keyshortcuts={drag?.onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onClick={(event) => {
          select();
          focusComposerOnActivation({
            activatedElement: event.currentTarget,
            settingsOpen: state.settingsOpen || state.appSettingsOpen,
          });
        }}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            drag?.onMove?.(event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            select();
            focusComposerOnActivation({
              activatedElement: event.currentTarget,
              settingsOpen: state.settingsOpen || state.appSettingsOpen,
            });
          } else if (event.key === " ") {
            event.preventDefault();
            select();
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
        data-arrival-glow={arrival.playing || undefined}
        onAnimationEnd={arrival.onAnimationEnd}
      >
        {body}
      </div>
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  closing,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  closing: boolean;
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (closing) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, closing, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(t("chrome.botRestored", { name: bot.name }));
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(t(bots.length === 1 ? "chrome.botsRestoredOne" : "chrome.botsRestoredMany", { count: bots.length }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("chrome.archivedBots")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("chrome.archiveKept")}</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                {t("chrome.restoreAll")}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label={t("chrome.closeArchived")}
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">
            {t("chrome.archivedCount", { count: bots.length })}
          </div>
          <div className={cn("grid grid-cols-1 gap-x-8", bots.length >= 2 && "md:grid-cols-2")}>
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || t("chrome.botFallback")}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  {t("chrome.restore")}
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export { ArchivedBotsPanel, BotListItem, GroupListItem };
export type { MenuState, SidebarRowDrag };
