import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { conversationPreview, roomConversationPreview } from "@/lib/conversation-preview";
import {
  moveSection,
  placeSection,
  sameSectionOrder,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import {
  api,
  terminalAttentionForBot,
  useStore,
  formatTime,
  visibleMessages,
  type Bot,
  type Group,
  type TerminalAttention,
} from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { useManualCheck, useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { showSidebarDensityControls, showSidebarPhone, showSidebarRoutines, showSidebarTeachSkill } from "@/lib/friends-chrome";
import { modelChipText, modelFamilyAccent } from "@/lib/model-chip";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { GroupWizard } from "./GroupWizard";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  displaySidebarWidth,
  dockedDetailsWidth,
  fitSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarDensity,
  loadSidebarOrder,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarDensity,
  saveSidebarOrder,
  saveSidebarWidth,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_ICONS_WIDTH,
  SIDEBAR_MAX_WIDTH,
  restoreSidebarDragWidth,
  snapSidebarDrag,
  stepSidebarLayout,
  type SidebarDensity,
  type SidebarLayout,
} from "@/lib/sidebar-preferences";
import {
  moveSidebarItem,
  moveSidebarItemWithinTier,
  normalizeSidebarOrder,
  orderedSidebarItems,
  partitionSidebarItemKeys,
  sidebarPriorityFor,
  sameSidebarOrder,
  sidebarItemKey,
  UNASSIGNED_SECTION_ID,
  type SidebarPriority,
  type SidebarItemKind,
  type SidebarItemOrder,
  type SidebarOrder,
} from "@/lib/sidebar-order";
import { sidebarConversationRowTone } from "@/lib/sidebar-row";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { phoneSettingsAvailable } from "@/lib/phone-availability";
import { localeTag, t, useI18n } from "@/lib/i18n";
import { terminalAttentionCopy } from "@/lib/notify";

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

export function compactSidebarModelLabel(label: string): string {
  return label.replace(/\s+Contributor$/i, " Cont.");
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
export function UpdateButton() {
  const { t } = useI18n();
  const s = useUpdaterState();
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  const { acknowledged: upToDate, check } = useManualCheck(status);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? t("update.versionAvailable", { version: s?.version ?? "" })
      : status === "downloading"
        ? s?.percent == null
          ? t("update.startingDownload")
          : t("update.downloadingPercent", { percent: Math.round(s.percent) })
        : status === "downloaded"
          ? t("update.versionReady", { version: s?.version ?? "" })
          : status === "installing"
            ? t("update.restarting")
            : status === "checking"
              ? t("update.checking")
              : upToDate
                ? t("update.upToDate")
                : t("settings.updates.check");

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot, showToolCalls = false): string {
  return conversationPreview(bot, t, showToolCalls);
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
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
  drag?: SidebarRowDrag;
}) {
  const { locale } = useI18n();
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
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
          dispatch({ type: "select", id: group.id });
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
            dispatch({ type: "select", id: group.id });
            focusComposerOnActivation({
              activatedElement: e.currentTarget,
              settingsOpen: state.settingsOpen || state.appSettingsOpen,
            });
            return;
          }
          if (e.key === " ") {
            e.preventDefault();
            dispatch({ type: "select", id: group.id });
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
        )}
        aria-label={density === "icons" ? group.name : undefined}
        aria-keyshortcuts={drag?.onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      >
        <StackedMauses members={members} density={density} />
        <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
          <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{group.name}</span>
            {last && (
              <span
                className={cn(
                  "shrink-0 text-xs text-ink-secondary",
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
            {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
          </div>
        </div>
      </button>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </div>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("chrome.renameChannel", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={t("chrome.saveChannelName")}
            title={t("room.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chrome.cancelChannelRename")}
            title={t("settings.browserProfiles.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {t("chrome.renameChannel", { name: group.name })}
        </button>
      )}
      <button
        onClick={() => {
          onClose();
          onMoveToSection(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <FolderPlus size={16} className="text-ink-secondary" />
        {t("chrome.moveToContext")}
      </button>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("chrome.copyConversationId")}
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/40"
      >
        <Trash2 size={16} />
        {t("chrome.deleteChannel")}
      </button>
    </div>,
    document.body,
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { t } = useI18n();
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {t("chrome.moveToContext")}
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("chrome.newContextName")}
          aria-label={t("chrome.newContextName")}
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          {t("chrome.add")}
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/40"
          >
            <FolderMinus size={15} />
            {t("chrome.removeFromContext")}
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
  onDeleteRequest,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
  onDeleteRequest: (bot: Bot) => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? t("chrome.chooseAnotherChief")
    : visibleBotCount <= 1
      ? t("chrome.keepOneBot")
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled
          ? "cursor-default opacity-40"
          : opts?.danger
            ? "hover:bg-raised/40"
            : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? t("chrome.unpin") : t("chrome.pin"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? t("chrome.removeChief") : t("chrome.makeChief"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          { hint: !bot.chiefOfStaff && !canCoordinate ? t("chrome.cannotContactTeammates") : undefined },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, t("chrome.moveToSection"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, t("chrome.markUnread"), () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, t("chrome.editProfile"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, t("chrome.duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("chrome.copyConversationId"), () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          t("chrome.archive"),
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(<Trash2 size={16} />, t("chrome.delete"), () => onDeleteRequest(bot), {
          danger: true,
        }),
      ]}
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
  onArchive,
  archiveDisabled,
  drag,
  onTerminalAttention,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
  drag?: SidebarRowDrag;
  onTerminalAttention?: (attention: TerminalAttention) => void;
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
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection?.instanceId);
  const modelLabel = engine && bot.modelSelection
    ? modelChipText({ instance: engine, model: bot.modelSelection.model, effort: bot.modelSelection.effort }, t)
    : null;
  const expandedModelLabel = modelLabel ? compactSidebarModelLabel(modelLabel) : null;
  const terminalAttention = terminalAttentionForBot(state.terminalAttention, bot.id);
  const terminalCopy = terminalAttention ? terminalAttentionCopy(terminalAttention.reason, locale) : null;
  const rowClass = cn(
    "flex w-full items-center rounded-xl border text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1 pr-10"
        : "gap-2 px-3 py-1.5 pr-12",
    sidebarConversationRowTone(selected),
  );
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
          // pose — N idle rows bobbing at display rate was most of the app's
          // visible-idle CPU (states are keyword-derived, so "working" can be
          // decorative; busy/unread/motion are the real signals).
          animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {bot.modelSelection && (
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
        {bot.unread && (
          <span
            data-sidebar-chat-unread
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute bottom-0.5 right-0.5 size-2 rounded-full border",
              selected ? "border-raised" : "border-panel",
              "bg-accent",
            )}
          />
        )}
        {terminalAttention && terminalCopy && (
          <button
            type="button"
            data-sidebar-terminal-attention
            data-terminal-session-id={terminalAttention.sessionId}
            data-terminal-reason={terminalAttention.reason}
            aria-label={`${bot.name}: ${terminalCopy.tooltip}`}
            title={terminalCopy.tooltip}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (onTerminalAttention) onTerminalAttention(terminalAttention);
              else dispatch({ type: "ackTerminalAttention", botId: terminalAttention.botId, sessionId: terminalAttention.sessionId });
            }}
            className={cn(
              "absolute -right-1 -top-1 z-10 flex size-5 items-center justify-center rounded-sm border bg-panel font-mono text-[9px] font-bold leading-none shadow-sm",
              terminalCopy.tone === "danger"
                ? "border-danger/60 text-danger hover:bg-danger/10"
                : terminalCopy.tone === "success"
                  ? "border-success/60 text-success hover:bg-success/10"
                  : "border-accent/60 text-accent hover:bg-accent/10",
            )}
          >
            <span aria-hidden="true">&gt;_</span>
          </button>
        )}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
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
          </span>
          {last && !renaming && (
            <span
              className={cn(
                "shrink-0 text-xs text-ink-secondary",
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

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
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
      title={iconOnly ? (modelLabel ? `${bot.name} · ${modelLabel}` : bot.name) : undefined}
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
        aria-label={iconOnly ? (modelLabel ? `${bot.name} · ${modelLabel}` : bot.name) : undefined}
        aria-keyshortcuts={drag?.onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onClick={(event) => {
          dispatch({ type: "select", id: bot.id });
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
            dispatch({ type: "select", id: bot.id });
            focusComposerOnActivation({
              activatedElement: event.currentTarget,
              settingsOpen: state.settingsOpen || state.appSettingsOpen,
            });
          } else if (event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {!iconOnly && <button
        type="button"
        disabled={archiveDisabled}
        onClick={() => onArchive(bot)}
        aria-label={t("chrome.archiveBot", { name: bot.name })}
        title={
          bot.chiefOfStaff
            ? t("chrome.chooseAnotherChief")
            : archiveDisabled
              ? t("chrome.keepOneBot")
              : t("chrome.archiveBot", { name: bot.name })
        }
        className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
      >
        <Archive size={14} />
      </button>}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
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
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
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
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || "Bot"}</div>
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

export function Sidebar({
  open,
  onClose,
  onTerminalAttention,
}: {
  open: boolean;
  onClose: () => void;
  onTerminalAttention?: (attention: TerminalAttention) => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const showPhone = showSidebarPhone() && phoneSettingsAvailable(capabilities.host);
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [drag, setDrag] = useState<{ kind: SidebarItemKind; from: string; over: string | null } | null>(null);
  const [itemSectionDropTarget, setItemSectionDropTarget] = useState<string | null>(null);
  const [sidebarOrder, setSidebarOrder] = useState<SidebarOrder>(() => loadSidebarOrder());
  const sidebarOrderRef = useRef(sidebarOrder);
  sidebarOrderRef.current = sidebarOrder;
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const [densityState, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadSidebarCollapsed());
  const density: SidebarDensity = sidebarCollapsed
    ? "icons"
    : showSidebarDensityControls() ? densityState : "comfortable";
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusSearchAfterExpand = useRef(false);
  const resizeFrom = useRef<{ x: number; width: number; collapsed: boolean; query: string } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Bot details docks beside the chat above the breakpoint and takes width from it.
  const dockedAsideWidth = dockedDetailsWidth(
    state.settingsOpen,
    state.groups.some((g) => g.id === state.selectedId),
    state.bots.length,
  );
  const sidebarDisplayWidth = displaySidebarWidth({
    collapsed: sidebarCollapsed,
    width: !sidebarCollapsed && density === "icons" ? SIDEBAR_ICONS_WIDTH : fitSidebarWidth(sidebarWidth, viewportWidth, dockedAsideWidth),
  });

  const applySidebarLayout = (next: SidebarLayout) => {
    if (next.collapsed) setQuery("");
    sidebarWidthRef.current = next.width;
    sidebarCollapsedRef.current = next.collapsed;
    setSidebarWidth(next.width);
    setSidebarCollapsed(next.collapsed);
  };

  const persistSidebarLayout = (next: SidebarLayout) => {
    saveSidebarWidth(next.width);
    saveSidebarCollapsed(next.collapsed);
  };

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const onSidebarResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!sidebarCollapsedRef.current && density === "icons") return;
    resizeFrom.current = {
      x: event.clientX,
      width: sidebarCollapsedRef.current ? sidebarWidthRef.current : fitSidebarWidth(sidebarWidthRef.current, viewportWidth, dockedAsideWidth),
      collapsed: sidebarCollapsedRef.current,
      query,
    };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onSidebarResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = snapSidebarDrag(
      { width: resizeFrom.current.width, collapsed: resizeFrom.current.collapsed },
      event.clientX - resizeFrom.current.x,
    );
    if (next.collapsed !== resizeFrom.current.collapsed) {
      resizeFrom.current = {
        x: event.clientX,
        width: next.width,
        collapsed: next.collapsed,
        query: resizeFrom.current.query,
      };
    }
    applySidebarLayout(next);
  };
  const onSidebarResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    setResizing(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    saveSidebarWidth(sidebarWidthRef.current);
    saveSidebarCollapsed(sidebarCollapsedRef.current);
  };
  const onSidebarResizeCancel = () => {
    const start = restoreSidebarDragWidth(resizeFrom.current);
    if (start == null || !resizeFrom.current) return;
    const queryToRestore = resizeFrom.current.query;
    resizeFrom.current = null;
    applySidebarLayout({ width: start.width, collapsed: start.collapsed });
    setQuery(queryToRestore);
    setResizing(false);
  };
  const onSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sidebarCollapsedRef.current && density === "icons") return;
    const next = stepSidebarLayout(
      {
        width: fitSidebarWidth(sidebarWidthRef.current, viewportWidth, dockedAsideWidth),
        collapsed: sidebarCollapsedRef.current,
      },
      event.key,
    );
    if (next == null) return;
    event.preventDefault();
    applySidebarLayout(next);
    saveSidebarWidth(next.width);
    saveSidebarCollapsed(next.collapsed);
  };

  useEffect(() => {
    if (!resizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  useEffect(() => {
    if (sidebarCollapsed || !focusSearchAfterExpand.current) return;
    focusSearchAfterExpand.current = false;
    // A touch device pops its virtual keyboard on focus, fighting the
    // expand animation. Only autofocus where a keyboard is already up.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    searchInputRef.current?.focus();
  }, [sidebarCollapsed]);

  const toggleCollapsed = () => {
    if (density === "icons") {
      if (sidebarCollapsed) {
        focusSearchAfterExpand.current = true;
        const next = { width: sidebarWidthRef.current, collapsed: false };
        applySidebarLayout(next);
        persistSidebarLayout(next);
      }
      setDensity(lastExpandedDensity);
    } else {
      setLastExpandedDensity(density);
      const next = { width: sidebarWidthRef.current, collapsed: true };
      applySidebarLayout(next);
      persistSidebarLayout(next);
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      setTeamFeedback({ error: false, text: t(exported.members === 1 ? "chrome.botsExportedOne" : "chrome.botsExported", { count: exported.members }) });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      await Promise.all([
        ...result.importedRoutineIds.map((routineId) =>
          api(`/api/routines/${routineId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "routineDeleted", routineId }),
          ),
        ),
        ...result.importedGroupIds.map((groupId) =>
          api(`/api/groups/${groupId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "groupDeleted", groupId }),
          ),
        ),
      ]);
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      const previousChiefs = result.archived.filter((bot) => bot.chiefOfStaff);
      const restoreOthers = await Promise.all(
        result.archived
          .filter((bot) => !bot.chiefOfStaff)
          .map((bot) =>
            api(`/api/bots/${bot.id}`, {
              method: "PATCH",
              body: JSON.stringify({ hidden: false }),
            }),
          ),
      );
      for (const response of restoreOthers) dispatch({ type: "botPatched", bot: response.bot });
      const restoredChiefs = await Promise.all(
        previousChiefs.map((previousChief) =>
          api(`/api/bots/${previousChief.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false, chiefOfStaff: true }),
          }),
        ),
      );
      for (const response of restoredChiefs) dispatch({ type: "botPatched", bot: response.bot });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: t("chrome.teamRestored") });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: t("chrome.botArchived", { name: bot.name }),
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: t("chrome.botRestored", { name: bot.name }) });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();
  const showToolCalls = showToolCallsEnabled(state.config);

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  type SidebarItem = {
    key: string;
    kind: SidebarItemKind;
    id: string;
    name: string;
    sectionId: string;
    sectionName: string;
    bot?: Bot;
    group?: Group;
  };
  const sectionIdFor = (section?: string) => section?.trim() ? userSectionId(section.trim()) : UNASSIGNED_SECTION_ID;
  const activeBots = state.bots.filter((bot) => !bot.hidden);
  const items: SidebarItem[] = [
    ...state.groups.map((group) => ({
      key: sidebarItemKey("group", group.id),
      kind: "group" as const,
      id: group.id,
      name: group.name,
      sectionId: sectionIdFor(group.section),
      sectionName: group.section?.trim() ?? "",
      group,
    })),
    ...activeBots.map((bot) => ({
      key: sidebarItemKey("bot", bot.id),
      kind: "bot" as const,
      id: bot.id,
      name: bot.name,
      sectionId: sectionIdFor(bot.section),
      sectionName: bot.section?.trim() ?? "",
      bot,
    })),
  ];
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const naturalItemsBySection: Record<string, string[]> = {};
  for (const item of items) (naturalItemsBySection[item.sectionId] ??= []).push(item.key);
  const naturalSectionIds = Object.keys(naturalItemsBySection);
  const allSectionIds = [
    UNASSIGNED_SECTION_ID,
    ...naturalSectionIds.filter((id) => id !== UNASSIGNED_SECTION_ID),
  ];
  const currentSidebarOrder = normalizeSidebarOrder(sidebarOrder, allSectionIds, naturalItemsBySection);
  const sectionOrder = currentSidebarOrder.sectionOrder;
  const matchingBots = activeBots.filter(
    (bot) =>
      !q ||
      bot.name.toLowerCase().includes(q) ||
      (bot.title ?? "").toLowerCase().includes(q) ||
      preview(bot, showToolCalls).toLowerCase().includes(q),
  );
  const visibleGroups = state.groups.filter((group) => !q || group.name.toLowerCase().includes(q));
  const matchingKeys = new Set([
    ...matchingBots.map((bot) => sidebarItemKey("bot", bot.id)),
    ...visibleGroups.map((group) => sidebarItemKey("group", group.id)),
  ]);
  const orderedKeysBySection: Record<string, string[]> = {};
  for (const id of allSectionIds) {
    const keys = orderedSidebarItems(naturalItemsBySection[id] ?? [], currentSidebarOrder.itemOrder[id] ?? []);
    orderedKeysBySection[id] = keys.filter((key) => matchingKeys.has(key));
  }
  const priorityByKey: Record<string, SidebarPriority | null> = {};
  for (const item of items) {
    priorityByKey[item.key] = item.kind === "bot" ? sidebarPriorityFor(item.bot!) : null;
  }
  const priorityPartition = partitionSidebarItemKeys(sectionOrder, orderedKeysBySection, priorityByKey);
  const priorityItemsByTier: Record<SidebarPriority, SidebarItem[]> = {
    chief: priorityPartition.chief.map((key) => itemByKey.get(key)).filter((item): item is SidebarItem => Boolean(item)),
    pinned: priorityPartition.pinned.map((key) => itemByKey.get(key)).filter((item): item is SidebarItem => Boolean(item)),
  };
  const orderedItemsBySection = new Map<string, SidebarItem[]>();
  for (const id of allSectionIds) {
    orderedItemsBySection.set(
      id,
      (priorityPartition.regular[id] ?? [])
        .map((key) => itemByKey.get(key))
        .filter((item): item is SidebarItem => Boolean(item)),
    );
  }
  const draggingItem = drag ? itemByKey.get(drag.from) : undefined;
  const showEmptyUnassignedDropTarget = q.length === 0 && Boolean(drag) && !(
    draggingItem?.kind === "bot" && sidebarPriorityFor(draggingItem.bot!)
  );
  const sectionIds = sectionOrder.filter((id) =>
    (orderedItemsBySection.get(id)?.length ?? 0) > 0 ||
    (id === UNASSIGNED_SECTION_ID && showEmptyUnassignedDropTarget),
  );
  const sectionsReorderable = density !== "icons" && q.length === 0 && sectionIds.length > 1;
  const rowsReorderable = q.length === 0;
  const currentItemOrder = () =>
    normalizeSidebarOrder(sidebarOrderRef.current, allSectionIds, naturalItemsBySection).itemOrder;
  const commitSidebarOrder = (
    candidate: SidebarOrder,
    presentItems: Readonly<Record<string, readonly string[]>> = naturalItemsBySection,
  ) => {
    const next = normalizeSidebarOrder(candidate, allSectionIds, presentItems);
    if (sameSidebarOrder(next, sidebarOrderRef.current)) return;
    sidebarOrderRef.current = next;
    setSidebarOrder(next);
    saveSidebarOrder(next);
  };
  const sectionLabel = (id: string) => id === UNASSIGNED_SECTION_ID ? t("chrome.unassigned") : userSectionName(id) ?? id;
  const commitSectionOrder = (visibleOrder: string[]) => {
    if (!sectionsReorderable) return;
    commitSidebarOrder({ ...sidebarOrderRef.current, sectionOrder: visibleOrder });
  };
  const announceSectionPosition = (id: string, visibleOrder: string[]) => {
    const position = visibleOrder.indexOf(id);
    if (position < 0) return;
    const name = userSectionName(id) ?? id;
    setReorderAnnouncement(`${name} moved to position ${position + 1} of ${visibleOrder.length}`);
  };
  const moveSidebarSection = (id: string, direction: -1 | 1) => {
    const next = moveSection(sectionIds, id, direction);
    if (sameSectionOrder(next, sectionIds)) return;
    commitSectionOrder(next);
    announceSectionPosition(id, next);
  };
  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setSectionDropTarget(null);
  };
  const resetRowDrag = () => {
    setDrag(null);
    setItemSectionDropTarget(null);
  };
  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!sectionsReorderable || !sectionDragRef.current.from || sectionDragRef.current.from === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setSectionDropTarget(next);
  };
  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from =
      event.dataTransfer.getData("application/x-openmausbot-sidebar-section") ||
      event.dataTransfer.getData("text/plain") ||
      sectionDragRef.current.from;
    const over = sectionDragRef.current.over;
    if (from && over) {
      const next = placeSection(sectionIds, from, over.id, over.place);
      if (!sameSectionOrder(next, sectionIds)) {
        commitSectionOrder(next);
        announceSectionPosition(from, next);
      }
    }
    resetSectionDrag();
  };
  const itemDropOrder = (toKey: string) => {
    if (!rowsReorderable || !drag) return null;
    const from = itemByKey.get(drag.from);
    const to = itemByKey.get(toKey);
    if (!from || !to || from.key === to.key) return null;
    const fromPriority = from.kind === "bot" ? sidebarPriorityFor(from.bot!) : null;
    const toPriority = to.kind === "bot" ? sidebarPriorityFor(to.bot!) : null;
    if (fromPriority !== toPriority || (fromPriority && from.sectionId !== to.sectionId)) return null;
    const itemOrder = currentItemOrder();
    const targetKeys = itemOrder[to.sectionId] ?? [];
    const targetIndex = targetKeys.indexOf(to.key);
    if (targetIndex < 0) return null;
    const sourceIndex = targetKeys.indexOf(from.key);
    const place = from.sectionId === to.sectionId && sourceIndex >= 0 && sourceIndex < targetIndex ? "after" : "before";
    const nextItemOrder = fromPriority
      ? moveSidebarItemWithinTier(
          itemOrder,
          from.sectionId,
          from.key,
          to.key,
          targetKeys.filter((key) => {
            const candidate = itemByKey.get(key);
            return candidate?.kind === "bot" && sidebarPriorityFor(candidate.bot!) === fromPriority;
          }),
          place,
        )
      : moveSidebarItem(itemOrder, from.sectionId, to.sectionId, from.key, to.key, place);
    const nextTarget = nextItemOrder[to.sectionId] ?? [];
    return {
      from,
      to,
      itemOrder: nextItemOrder,
      targetSectionId: to.sectionId,
      edge: nextTarget.indexOf(to.key) < nextTarget.indexOf(from.key) ? "bottom" as const : "top" as const,
    };
  };
  const applyItemDrop = (
    drop: ReturnType<typeof itemDropOrder> | { from: SidebarItem; to?: SidebarItem; itemOrder: SidebarItemOrder; targetSectionId: string } | null,
    fromKey: string,
  ) => {
    const from = itemByKey.get(fromKey);
    resetRowDrag();
    if (!drop || !from) return;
    const presentItems = Object.fromEntries(
      Object.entries(naturalItemsBySection).map(([id, keys]) => [id, [...keys]]),
    );
    if (from.sectionId !== drop.targetSectionId) {
      presentItems[from.sectionId] = (presentItems[from.sectionId] ?? []).filter((key) => key !== from.key);
      presentItems[drop.targetSectionId] = [...(presentItems[drop.targetSectionId] ?? []), from.key];
    }
    commitSidebarOrder({ ...sidebarOrderRef.current, itemOrder: drop.itemOrder }, presentItems);
    if (from.sectionId === drop.targetSectionId) return;
    const section = drop.targetSectionId === UNASSIGNED_SECTION_ID ? "" : userSectionName(drop.targetSectionId) ?? "";
    if (from.kind === "bot") dispatch({ type: "updateBot", botId: from.id, patch: { section } });
    else dispatch({ type: "patchGroup", groupId: from.id, patch: { section } });
    setReorderAnnouncement(`${from.name} moved to ${sectionLabel(drop.targetSectionId)}`);
  };
  const updateItemSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!rowsReorderable || !drag) return false;
    const from = itemByKey.get(drag.from);
    if (!from || from.sectionId === id || (from.kind === "bot" && sidebarPriorityFor(from.bot!))) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (itemSectionDropTarget !== id) setItemSectionDropTarget(id);
    if (drag.over !== null) setDrag((current) => (current ? { ...current, over: null } : null));
    return true;
  };
  const dropItemInSection = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    if (!drag) {
      resetRowDrag();
      return;
    }
    const from = itemByKey.get(drag.from);
    if (!from || from.sectionId === id || (from.kind === "bot" && sidebarPriorityFor(from.bot!))) {
      resetRowDrag();
      return;
    }
    const itemOrder = moveSidebarItem(currentItemOrder(), from.sectionId, id, from.key, undefined, "end");
    applyItemDrop({ from, itemOrder, targetSectionId: id }, from.key);
  };
  const isSidebarRowEvent = (event: React.DragEvent<HTMLDivElement>) => {
    const target = event.target;
    return target instanceof Element && Boolean(target.closest("[data-sidebar-row]"));
  };
  const sectionDragOver = (event: React.DragEvent<HTMLDivElement>, id: string, _name: string) => {
    if (drag) {
      if (!isSidebarRowEvent(event)) updateItemSectionDropTarget(event, id);
      return;
    }
    updateSectionDropTarget(event, id);
  };
  const sectionDrop = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (drag) {
      if (!isSidebarRowEvent(event)) dropItemInSection(event, id);
      return;
    }
    dropSection(event);
  };
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const moveItemByKeyboard = (key: string, direction: -1 | 1) => {
    if (!rowsReorderable) return;
    const item = itemByKey.get(key);
    if (!item) return;
    const itemOrder = currentItemOrder();
    const priority = item.kind === "bot" ? sidebarPriorityFor(item.bot!) : null;
    const keys = (itemOrder[item.sectionId] ?? []).filter((candidateKey) => {
      if (!priority) return true;
      const candidate = itemByKey.get(candidateKey);
      return candidate?.kind === "bot" && sidebarPriorityFor(candidate.bot!) === priority;
    });
    const index = keys.indexOf(key);
    if (index < 0) return;
    if ((direction < 0 && index > 0) || (direction > 0 && index < keys.length - 1)) {
      const targetKey = keys[index + direction]!;
      const place = direction < 0 ? "before" : "after";
      applyItemDrop({
        from: item,
        to: itemByKey.get(targetKey),
        itemOrder: priority
          ? moveSidebarItemWithinTier(itemOrder, item.sectionId, key, targetKey, keys, place)
          : moveSidebarItem(itemOrder, item.sectionId, item.sectionId, key, targetKey, place),
        targetSectionId: item.sectionId,
      }, key);
      return;
    }
    if (priority) return;
    const sectionIndex = sectionIds.indexOf(item.sectionId);
    const targetSectionId = sectionIds[sectionIndex + direction];
    if (!targetSectionId) return;
    const targetKeys = itemOrder[targetSectionId] ?? [];
    const targetKey = direction > 0 ? targetKeys[0] : undefined;
    applyItemDrop({
      from: item,
      to: targetKey ? itemByKey.get(targetKey) : undefined,
      itemOrder: moveSidebarItem(itemOrder, item.sectionId, targetSectionId, key, targetKey, direction > 0 ? "before" : "end"),
      targetSectionId,
    }, key);
  };
  const rowDrag = (item: SidebarItem): SidebarRowDrag => {
    const order = drag?.over === item.key ? itemDropOrder(item.key) : null;
    return {
      edge: order?.edge ?? null,
      onStart: () => {
        setItemSectionDropTarget(null);
        setDrag({ kind: item.kind, from: item.key, over: null });
      },
      onOver: () => {
        if (!drag) return false;
        const over = itemDropOrder(item.key) ? item.key : null;
        if (over) setItemSectionDropTarget(null);
        if (drag.over !== over) setDrag((current) => (current ? { ...current, over } : null));
        return over !== null;
      },
      onLeave: () => setDrag((current) => (current?.over === item.key ? { ...current, over: null } : current)),
      onDrop: () => {
        const fromKey = drag?.from ?? item.key;
        applyItemDrop(itemDropOrder(item.key), fromKey);
      },
      onEnd: resetRowDrag,
      onMove: (direction) => moveItemByKeyboard(item.key, direction),
    };
  };
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <aside
      aria-label={t("chrome.navAria")}
      className={cn(
        "relative flex h-full min-w-0 shrink-0 flex-col border-r border-hairline/40 bg-panel",
        // md and up only: below md, width is a layout property fighting the
        // translate-based drawer slide (both animating the same frame) — that
        // pane leaves width alone and animates transform only, see below.
        !resizing && "md:transition-[width] md:duration-200",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents the wizard overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
      style={{ width: sidebarDisplayWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chrome.resizeSidebar")}
        tabIndex={0}
        aria-valuenow={sidebarDisplayWidth}
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuetext={t("chrome.sidebarWidthPixels", { width: sidebarDisplayWidth })}
        data-sidebar-resize
        onPointerDown={onSidebarResizeStart}
        onPointerMove={onSidebarResizeMove}
        onPointerUp={onSidebarResizeEnd}
        onPointerCancel={onSidebarResizeCancel}
        onKeyDown={onSidebarResizeKeyDown}
        className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize touch-none hover:bg-accent/40 focus-visible:bg-accent/60 md:block"
      />
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pt-3.5 pb-1", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center", density === "icons" ? "flex-col gap-1" : "gap-1")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? t("chrome.expandSidebar") : t("chrome.collapseSidebar")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? t("chrome.expandSidebar") : t("chrome.collapseSidebar")}
          >
            {density === "icons" ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          {showSidebarDensityControls() && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label={t("chrome.sidebarDensity")}
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title={t("chrome.sidebarDensity")}
            >
              <span aria-hidden="true" className="flex size-5 flex-col items-center justify-center gap-[3px]">
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityOpen(false)} />
                <div className={cn(
                  "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                )}>
                  {(["comfortable", "compact", "icons"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDensity(option)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-raised/70",
                        density === option ? "text-accent" : "text-ink",
                      )}
                    >
                      {option === "icons"
                        ? t("chrome.densityAvatars")
                        : option === "compact"
                          ? t("chrome.densityCompact")
                          : t("chrome.densityComfortable")}
                      {density === option && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          )}
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={t("chrome.newOrShare")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("chrome.newOrShare")}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  {t("chrome.newBot")}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setWizard(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  {t("chrome.newChannel")}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? t("chrome.exporting") : t("chrome.exportAllBots")}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  {t("chrome.teams")}
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">{t("chrome.archivedBots")}</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      {density === "icons" ? (
        <div className="flex justify-center px-1 pt-2 pb-2">
          <button
            type="button"
            onClick={() => {
              const next = { width: sidebarWidthRef.current, collapsed: false };
              applySidebarLayout(next);
              persistSidebarLayout(next);
              focusSearchAfterExpand.current = true;
            }}
            aria-label={t("chrome.searchBotsAria")}
            title={t("chrome.search")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Search size={16} />
          </button>
        </div>
      ) : (
        <div className="px-3 pt-2 pb-3">
          <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
            <Search size={16} className="text-ink-secondary" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder={t("chrome.search")}
              aria-label={t("chrome.searchBotsAria")}
              className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Bot list */}
      <div className={cn("min-w-0 flex-1 overflow-x-hidden overflow-y-auto", density === "icons" ? "px-0" : "px-2")}>
        <div className="flex flex-col gap-0.5">
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">{t("palette.noMatch", { query })}</div>
          )}
          {(["chief", "pinned"] as const).map((tier) => {
            const priorityItems = priorityItemsByTier[tier];
            if (priorityItems.length === 0) return null;
            return (
              <div key={tier} data-sidebar-priority-tier={tier} className="flex flex-col gap-0.5">
                {priorityItems.map((item) => (
                  <BotListItem
                    key={item.key}
                    bot={item.bot!}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(candidate) => void archiveBot(candidate)}
                    archiveDisabled={Boolean(item.bot!.chiefOfStaff) || activeBotCount <= 1}
                    drag={rowsReorderable ? rowDrag(item) : undefined}
                    onTerminalAttention={onTerminalAttention}
                  />
                ))}
              </div>
            );
          })}
          {sectionIds.map((id) => {
            const name = sectionLabel(id);
            const sectionItems = orderedItemsBySection.get(id) ?? [];
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                data-sidebar-bot-drop-zone={id === UNASSIGNED_SECTION_ID ? "" : name}
                data-sidebar-item-drop-zone={id}
                className="flex flex-col gap-0.5"
                onDragEnter={(event) => sectionDragOver(event, id, name)}
                onDragOver={(event) => sectionDragOver(event, id, name)}
                onDrop={(event) => sectionDrop(event, id)}
              >
                {sectionDropTarget?.id === id && sectionDropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
                {itemSectionDropTarget === id && (
                  <div data-sidebar-bot-drop-marker className="mx-1 my-1 h-1 rounded-full bg-accent shadow-[0_0_8px] shadow-accent/60" />
                )}
                {density !== "icons" && (
                  <SidebarSectionHeader
                    name={name}
                    reorderable={sectionsReorderable}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-openmausbot-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onDragOver={(event) => sectionDragOver(event, id, name)}
                    onDrop={(event) => sectionDrop(event, id)}
                    onMove={(direction) => moveSidebarSection(id, direction)}
                  />
                )}
                {sectionItems.map((item) => item.kind === "group" ? (
                  <GroupListItem
                    key={item.key}
                    group={item.group!}
                    density={density}
                    onMenu={setRoomMenu}
                    drag={rowsReorderable ? rowDrag(item) : undefined}
                  />
                ) : (
                  <BotListItem
                    key={item.key}
                    bot={item.bot!}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(candidate) => void archiveBot(candidate)}
                    archiveDisabled={Boolean(item.bot!.chiefOfStaff) || activeBotCount <= 1}
                    drag={rowsReorderable ? rowDrag(item) : undefined}
                    onTerminalAttention={onTerminalAttention}
                  />
                ))}
                {sectionDropTarget?.id === id && sectionDropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          <SearchResults query={query} onLanded={() => setQuery("")} />
          <span className="sr-only" aria-live="polite">{reorderAnnouncement}</span>
        </div>
      </div>

      {/* Footer */}
      <div className={cn("min-w-0 overflow-x-hidden pb-3 pt-2", density === "icons" ? "px-2" : "px-3")} data-sidebar-footer>
        {density === "icons" && (
          <div className="flex min-h-10 items-center justify-center" data-sidebar-update>
            <UpdateButton />
          </div>
        )}
        {showSidebarTeachSkill() && skillRecorderEnabled(state.config) && (
          <button
            onClick={() => dispatch({ type: "showSkillRecorder" })}
            aria-label={density === "icons" ? t("chrome.teachSkill") : undefined}
            title={density === "icons" ? t("chrome.teachSkill") : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "skill-recorder" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <Sparkles size={20} className={state.activeView === "skill-recorder" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>{t("chrome.teachSkill")}</span>
          </button>
        )}
        {showSidebarRoutines() && (
        <button
          onClick={() => dispatch({ type: "showRoutines" })}
          aria-label={density === "icons" ? t("chrome.routines") : undefined}
          title={density === "icons" ? t("chrome.routines") : undefined}
          className={cn(
            "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
            state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
          <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>{t("chrome.routines")}</span>
          {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
            <span className="size-2 rounded-full bg-danger" />
          )}
        </button>
        )}
        {showPhone && density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
        <div className={cn("flex min-w-0 items-center", density === "icons" && "justify-center")} data-sidebar-profile-row>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className={cn("flex min-w-0 items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "flex-1 gap-3 px-3")}
            aria-label={density === "icons" ? t("chrome.appSettings") : undefined}
            title={density === "icons" ? (state.config?.profile?.name?.trim() || t("chrome.appSettings")) : undefined}
          >
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            <span className={cn("truncate text-[14px] text-ink", density === "icons" && "hidden")}>
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || t("chrome.you")}
            </span>
          </button>
          {density !== "icons" && (
            <div className="flex shrink-0 items-center" data-sidebar-update>
              <UpdateButton />
            </div>
          )}
          {showPhone && density !== "icons" && (
            <SidebarPhoneButton
              density={density}
              onOpen={() => dispatch(phoneSettingsAction())}
            />
          )}
          {density !== "icons" && <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            aria-label={t("chrome.appSettings")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("chrome.appSettings")}
          >
            <Settings size={18} aria-hidden="true" />
          </button>}
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
          onDeleteRequest={(bot) => setDeleteTarget(bot)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={t("chrome.deleteBotTitle")}
          body={t("chrome.deleteBotBody", { name: deleteTarget.name })}
          confirmLabel={t("chrome.delete")}
          onConfirm={() => {
            dispatch({ type: "deleteBot", botId: deleteTarget.id });
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } })}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {wizard && <GroupWizard onClose={() => setWizard(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback(
              result.archived.length > 0
                ? {
                    error: false,
                    text: t(result.members === 1 ? "chrome.teamLoadedOne" : "chrome.teamLoadedMany", { name: result.name, count: result.members }),
                    undo: result,
                  }
                : {
                    error: false,
                    text: t(result.members === 1 ? "chrome.teamLoadedOne" : "chrome.teamLoadedMany", { name: result.name, count: result.members }),
                  },
            );
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  {t("chrome.undo")}
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  {t("chrome.undo")}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
