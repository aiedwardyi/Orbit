import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  Gauge,
  ListTree,
  Loader2,
  Monitor,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  TerminalSquare,
  Webhook,
  X,
} from "lucide-react";
import {
  useStore,
  useStreaming,
  formatDateTime,
  formatTime,
  messageVersions,
  openNotificationTarget,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { EngineSetup, OpenConnectionsCta, setupErrorAction } from "./EngineSetup";
import { BotAvatar } from "./Avatar";
import { MessageBoundary, TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { showBotNewTaskControl, showComputerPanelChrome } from "@/lib/friends-chrome";
import { stateForBot } from "@/lib/mascot";
import { transcriptIdleAfterOnboarding } from "@/lib/conversation-preview";
import { turnPresenceWaiting, withAcceptedMessages } from "@/lib/send-accept";
import { liveActivityLabel } from "@/lib/live-activity";
import { buffersForTurn, turnPhase, turnStageLabel } from "@/lib/turn-stage";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ChatPlanMeters } from "./ChatPlanMeters";
import { useNow } from "./PlanUsageBar";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachedImageGallery, ShownImage } from "./AttachmentPreview";
import { ModelPicker } from "./ModelPicker";
import { DeviceTag } from "./DeviceSwitcher";
import { RenameTitle } from "./RenameTitle";
import { TaskPicker } from "./TaskPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { usageLimitReset } from "@/lib/usage";
import { useFocusMessage } from "@/lib/focus-message";
import { screenImageUrl, useJumpWindow, useOlderMessages, useThreadMessage } from "@/lib/message-pages";
import { activityVisibleInChat, groupActivityRuns } from "@/lib/activity-runs";
import { chatTranscriptRows, messageVisible } from "@/lib/chat-transcript";
import { detectChatOptions, laterUserAnswer } from "@/lib/chat-options";
import { focusComposerOnActivation, shouldFocusComposerOnTranscriptClick } from "@/lib/focus-composer";
import { ChatOptionChips } from "./ChatOptionChips";
import { MemorySaveChip } from "./MemorySaveChip";
import { ActivityRun, ActivityStep } from "./ActivityRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { placeTooltip } from "@/lib/tooltip-position";
import { TRANSCRIPT_GAP, useComposerDockPad } from "@/lib/composer-dock";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  followedTailStart,
  resolveTranscriptWindow,
  shiftForPrepend,
  tailWindowStart,
} from "@/lib/transcript-window";
import { timelineEvents } from "@/lib/taskTimeline";
import { useReplyDraft } from "@/lib/drafts";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { localeTag, useI18n } from "@/lib/i18n";
import { activeRunForBot, routineWorkingElsewhere } from "../../shared/working-thread";
import { ContextCompactionDivider, TaskRecoveryCard } from "./TaskRecoveryCard";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;
/** Older pages fetched looking for the prompt behind a bot-only branch. */
const PROMPT_PAGES = 3;
/** Tries at a scrollback page during an edit join before it waits for Show earlier. */
const JOIN_TRIES = 3;
const JOIN_RETRY_MS = 1000;

const NOTE_HEADER = /^\[pane ([0-9a-f]{1,8})\](?: \[([^\]]+)\])?/;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number, t: (key: import("@/lib/i18n").MessageKey) => string, locale: import("@/lib/i18n").LocaleId): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.today");
  if (diffDays === 1) return t("chat.yesterday");
  return d.toLocaleDateString(localeTag(locale), { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  const { t, locale } = useI18n();
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, t, locale)} {formatTime(at, localeTag(locale))}
    </div>
  );
}

function TaskTimeline({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const events = useMemo(() => timelineEvents(messages), [messages]);
  if (events.length === 0) return null;
  const recent = events.slice(-8);
  return (
    <div className="w-full px-5 pt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
      >
        <span className="flex items-center gap-1.5">
          <ListTree size={14} /> {t(busy ? "chat.executionTimelineRunning" : "chat.executionTimeline")}
        </span>
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="ml-2 border-l border-hairline/40 pb-2 pl-3">
          {recent.map((event) => (
            <li key={event.id} className="relative flex items-center gap-2 py-1 text-[12px] text-ink-secondary">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[17px] size-2 rounded-full",
                  event.state === "failed"
                    ? "bg-danger"
                    : event.state === "complete"
                      ? "bg-success"
                      : event.state === "running"
                        ? "animate-pulse bg-accent"
                        : "bg-ink-secondary",
                )}
              />
              <span className="sr-only">{event.state}: </span>
              <span className="truncate">{event.label}</span>
              <time className="ml-auto shrink-0 text-[11px] text-ink-secondary/70">{formatTime(event.at, localeTag(locale))}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={t("chat.copyMessage")}
      title={t("chat.copyMessage")}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal.
 *
 * A spent subscription window is neither: it is an expected state with a
 * known end, so it drops the provider's raw wording for our own, goes
 * warning-toned rather than danger-toned, and keeps the Retry that the
 * reset makes worth pressing. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
  usageLimit,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
  usageLimit?: { resetsAt: number | null };
}) {
  const { t } = useI18n();
  const now = useNow();
  const action = setupErrorAction(message, setupInstance);
  const reset = usageLimit ? usageLimitReset(usageLimit.resetsAt, now) : null;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "w-fit max-w-[min(42rem,78%)] rounded-xl border px-3.5 py-2.5 text-[13.5px]",
          usageLimit ? "border-warning/30 bg-warning/10 text-warning" : "border-danger/30 bg-danger/10 text-danger",
        )}
      >
        <div className="flex items-start gap-2">
          {usageLimit ? <Gauge size={15} className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 break-words">
            {usageLimit ? (
              <>
                <span className="font-semibold">{t("chat.usageLimit")}</span>{" "}
                {t("chat.usageLimitBody")}
                {reset && <> {t(reset.key, reset.vars)}</>}
                {/* the engine's own words survive a misread of them */}
                <span className="mt-1 block text-[12px] opacity-70">{message}</span>
              </>
            ) : (
              message
            )}
          </span>
        </div>
        {action === "cli" && setupInstance ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action === "key" ? (
          <OpenConnectionsCta />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className={cn(
                "mt-1.5 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px]",
                usageLimit ? "border-warning/30 hover:bg-warning/15" : "border-danger/30 hover:bg-danger/15",
              )}
            >
              <RefreshCw size={12} /> {t("composer.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {t("createBot.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-accent-ink disabled:opacity-40"
        >
          {t("composer.send")}
        </button>
      </div>
    </div>
  );
}

/** Short time under a bubble; hover or focus it for the full date. Portalled
 *  under the body so the transcript's overflow-x-hidden cannot clip it, and so
 *  the date stays out of the transcript's live region: otherwise every
 *  arriving message would be read out with its own datestamp. */
function TimestampLabel({ at, hidden = false }: { at: number; hidden?: boolean }) {
  const { locale } = useI18n();
  const tag = localeTag(locale);
  const full = useMemo(() => formatDateTime(at, tag), [at, tag]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const tipId = useId();

  // Measured, then clamped to the window: centred on the label would run off
  // the screen for a short bubble at either edge.
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const width = tipRef.current?.offsetWidth;
      const height = tipRef.current?.offsetHeight;
      if (!anchor || !width || !height) return;
      setBox(
        placeTooltip({
          anchor,
          size: { width, height },
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    const transcript = anchorRef.current?.closest("[data-orbit-transcript]");
    window.addEventListener("resize", place);
    transcript?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      transcript?.removeEventListener("scroll", place);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        // Pointed at the tip only once it is placed and visible: whether a
        // hidden referenced node still contributes its text is not something
        // to bet on, so the reference never rests on one.
        aria-describedby={box ? tipId : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={cn("mt-0.5 cursor-default rounded text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", hidden && "invisible")}
      >
        {formatTime(at, tag)}
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            // hidden for the one commit it takes to measure, so it never
            // paints in the corner on the way to its place
            style={{ top: box?.top ?? 0, left: box?.left ?? 0, visibility: box ? "visible" : "hidden" }}
            className="pointer-events-none fixed z-40 max-w-[min(20rem,calc(100vw-1rem))] rounded-md border border-hairline/40 bg-panel px-2 py-1 text-[11px] text-ink-secondary shadow-sm"
          >
            {full}
          </div>,
          document.body,
        )}
    </>
  );
}

const Bubble = memo(function Bubble({
  bot,
  message,
  transcript,
  editing,
  isLastBotText,
  streaming = false,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
  onFocusComposer,
}: {
  bot: Bot;
  message: Message;
  transcript: Message[];
  editing: boolean;
  isLastBotText: boolean;
  streaming?: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
  onFocusComposer: () => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const quoted = useThreadMessage(bot.threadId, bot.hasMore ? message.replyToId : undefined, replyTarget);
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  // the folder this task's turns run in: pinned once a turn ran, else the bot's own
  const pinnedFolder = bot.tasks?.find((task) => task.threadId === bot.threadId)?.cwd;
  const botFolder = pinnedFolder === undefined ? bot.cwd : pinnedFolder;
  const detectedOptions = !user && !streaming && message.kind === "text" ? detectChatOptions(text) : null;
  const answeredChoice = detectedOptions ? laterUserAnswer(transcript, message.id) : null;
  const optionChoices =
    detectedOptions && (answeredChoice != null || isLastBotText) ? detectedOptions : null;
  const markdownText =
    optionChoices?.messagePrefix != null ? optionChoices.messagePrefix : text;
  const webhookView = user ? webhookMessageView(text) : null;
  const attachedImages = user && !webhookView ? splitAttachedImages(text) : null;
  const visibleText = webhookView?.task ?? attachedImages?.display ?? text;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={(text) => onSubmitEdit(message.id, text)} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const hasReactions = !message.placeholder && Boolean(message.reactions?.length);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div
      data-orbit-message={user ? "user" : "bot"}
      className={cn("group flex w-full flex-col outline-none", user ? "animate-msg-in items-end" : "items-start")}
      tabIndex={-1}
    >
      {/* padded so the docked action row below the bubble
          keeps out of the timestamp and reaction chips that follow it */}
      <div
        data-orbit-message-body
        className={cn("relative w-fit max-w-[min(42rem,78%)]", hasReactions ? "pb-11" : "pb-8")}
      >
        <div className="orbit-message-speaker hidden">{user ? t("chat.you") : bot.name}</div>
        {user && !message.placeholder && (
          <div
            data-message-hover-actions
            className="pointer-events-none absolute right-0 bottom-0 z-20 flex items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          >
            {/* editing rewinds the thread, so it waits for the turn to end —
                same rule as the version switcher below */}
            {message.kind === "text" && !webhookView && !bot.busy && (
              <button
                onClick={() => onStartEdit(message.id)}
                aria-label={t("chat.editMessage")}
                className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                title={t("chat.editMessage")}
              >
                <Pencil size={14} />
              </button>
            )}
            <CopyButton text={visibleText} className="opacity-100" />
            <button
              type="button"
              onClick={() => onReply(message)}
              aria-label={t("chat.replyToMessage")}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={t("chat.replyToMessage")}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={() =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }
              aria-label={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
              aria-pressed={bot.pinnedMessageId === message.id}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
            >
              {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
        )}
        <div
          data-orbit-message-content
          className={cn(
            "w-fit max-w-full rounded-2xl text-[15px] leading-relaxed",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : message.summarized
                  ? "bg-card px-4 py-2.5 text-ink-secondary"
                  : "bg-card px-4 py-2.5 text-ink",
          )}
        >
          {quoted && (
            <div className="mb-2">
              <ReplyQuote
                message={quoted}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: quoted.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>Webhook task</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">View event payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachedImages && attachedImages.images.length > 0 && (
                <AttachedImageGallery paths={attachedImages.images} />
              )}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                {visibleText}
              </div>
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title="Sent while the bot was working — it saw this before its next step, inside the same turn.">
                  sent mid-turn
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : markdownText.trim() ? (
            <MessageBoundary fallbackText={markdownText}>
              <ChatMarkdown text={markdownText} streaming={streaming} baseDir={botFolder} threadId={bot.threadId} />
            </MessageBoundary>
          ) : null}
          {!user && message.summarized && (
            <div className="mt-1 text-[11px] text-ink-secondary/70" title="Claude shortened this mid-task note. Its exact words weren't kept.">
              summarized
            </div>
          )}
        </div>
        {!user && !streaming && (
          <div
            data-message-hover-actions
            // left, not right: the row is wider than a short bot bubble, and
            // the wrapper is w-fit, so right-0 would grow it off the left edge
            className="pointer-events-none absolute bottom-0 left-0 z-20 flex items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100"
          >
            {message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
            <CopyButton text={text} className="opacity-100" />
            {isLastBotText && !bot.busy && onRegenerate && (
              <button
                onClick={onRegenerate}
                aria-label={t("chat.regenerate")}
                title={t("chat.regenerate")}
                className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <RefreshCw size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onReply(message)}
              aria-label={t("chat.replyToMessage")}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={t("chat.replyToMessage")}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={() =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }
              aria-label={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
              aria-pressed={bot.pinnedMessageId === message.id}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
            >
              {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
        )}
        {!message.placeholder && (
          <ReactionChips
            threadId={bot.threadId}
            message={message}
            members={[bot]}
            corner={user ? "left" : "right"}
            className="bottom-11"
          />
        )}
      </div>
      {optionChoices && (
        <ChatOptionChips
          options={optionChoices.options}
          question={optionChoices.question}
          answeredText={answeredChoice}
          disabled={!answeredChoice && bot.busy}
          onPick={(option) => dispatch({ type: "send", botId: bot.id, text: option })}
          onWriteOwn={onFocusComposer}
        />
      )}
      <TimestampLabel at={message.at} hidden={streaming} />
      {!message.placeholder && versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.nextVersion")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
});

/** A tool run: spinner while live, check/cross once settled. A failed step
 * stays neutral; only turn-level `error:` rows go red. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch, state } = useStore();
  const { t } = useI18n();
  const tool = message.tool;
  if (!tool) return null;
  if (tool.name === "memory.save") return <MemorySaveChip summary={tool.spoken ?? ""} at={message.at} />;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    const peer = state.bots.find((bot) => bot.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={peer ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        title={failed ? t("chat.stepDidNotComplete") : undefined}
        className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} strokeWidth={1.5} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">
          {tool.name}
          {tool.summary && ` ${tool.summary}`}
        </span>
      </div>
    </div>
  );
}

function ScreenFrame({ src, caption }: { src: string; caption?: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <img
        src={src}
        alt={caption || "Bot's screen"}
        className="w-fit max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40"
      />
      {caption && <p className="max-w-[min(42rem,78%)] px-1 text-[13px] text-ink-secondary">{caption}</p>}
    </div>
  );
}

function NoteMessage({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const text = message.text ?? "";
  const match = NOTE_HEADER.exec(text);
  const label = match ? (match[2] ?? `pane ${match[1]}`) : null;
  return (
    <div className="flex w-full flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-lg border border-hairline/30 bg-inset/25 px-3 py-1.5 text-[12.5px] text-ink-secondary hover:text-ink"
      >
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
        {label ? `Note from ${label}` : "Note"}
      </button>
      {open && (
        // pane text is untrusted; plain text only, never markdown
        <div data-orbit-note className="w-full max-w-2xl whitespace-pre-wrap break-words rounded-lg border border-hairline/30 bg-inset/25 px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
          {text}
        </div>
      )}
    </div>
  );
}

/** Bot-spawned pane ids still open, null until the bridge answers. One snapshot read per bot. */
function useLivePanes(botId: string, enabled: boolean): Set<string> | null {
  const [live, setLive] = useState<Set<string> | null>(null);
  useEffect(() => {
    const bridge = window.ogb?.terminal;
    setLive(null);
    if (!bridge || !enabled) return;
    let alive = true;
    void Promise.resolve().then(() => bridge.readBot?.(botId)).then((snapshot) => {
      if (!alive || !snapshot?.panes) return;
      const ids = snapshot.panes.filter((p) => !p.main).map((p) => p.sessionId);
      setLive((current) => new Set([...ids, ...(current ?? [])]));
    }).catch(() => {});
    const offOpened = bridge.onOpened?.((event) => {
      if (event.botId === botId) setLive((current) => new Set([...(current ?? []), event.id]));
    });
    const offClosed = bridge.onClosed?.((event) => {
      if (event.botId === botId) setLive((current) => { const next = new Set(current ?? []); next.delete(event.id); return next; });
    });
    return () => { alive = false; offOpened?.(); offClosed?.(); };
  }, [botId, enabled]);
  return live;
}

function LaunchMessage({ message, livePanes, onOpenTerminalPane }: { message: Message; livePanes: Set<string> | null; onOpenTerminalPane?: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [header, ...details] = (message.text ?? "").split("\n");
  const sessionId = details.find((l) => l.startsWith("Session: "))?.slice("Session: ".length).trim();
  // unknown (no bridge answer yet) behaves like closed minus the label: expand only
  const live = livePanes && sessionId ? livePanes.has(sessionId) : null;
  const jump = live && sessionId && onOpenTerminalPane ? () => onOpenTerminalPane(sessionId) : null;
  const rowClass = "flex items-center gap-1 rounded-lg border border-hairline/30 bg-inset/25 text-[12.5px] text-ink-secondary";
  return (
    <div className="flex w-full flex-col items-start gap-1">
      {jump ? (
        <div className={rowClass}>
          <button type="button" onClick={jump} className="py-1.5 pl-3 hover:text-ink">{header}</button>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Details" className="py-1.5 pl-1 pr-3 hover:text-ink">
            <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={cn(rowClass, "px-3 py-1.5 hover:text-ink")}>
          <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
          {live === false ? `${header} · closed` : header}
        </button>
      )}
      {open && (
        <div data-orbit-launch className="w-full max-w-2xl whitespace-pre-wrap break-words rounded-lg border border-hairline/30 bg-inset/25 px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
          {details.join("\n")}
        </div>
      )}
    </div>
  );
}

// Keep the live reply in its transcript slot when the canonical message arrives.
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  transcript,
  editingId,
  lastBotTextId,
  canonicalLastMessageId,
  streamingMessage,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
  onFocusComposer,
  onOpenTerminalPane,
}: {
  bot: Bot;
  messages: Message[];
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  canonicalLastMessageId: string | undefined;
  streamingMessage: Message | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
  onFocusComposer: () => void;
  onOpenTerminalPane?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const livePanes = useLivePanes(bot.id, useMemo(() => messages.some((m) => m.kind === "launch"), [messages]));
  // Fold finished tool chips into runs, so a stretch of them cannot bury
  // what the bot actually said. Hidden unless Settings → Tool calls is on.
  const items = useMemo(
    () => groupActivityRuns(streamingMessage ? [...messages, streamingMessage] : messages),
    [messages, streamingMessage],
  );
  const rows = useMemo(
    () => chatTranscriptRows(items, { showToolCalls, transcript }),
    [items, showToolCalls, transcript],
  );
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  return (
    <>
      {transcriptIdleAfterOnboarding(transcript) && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {bot.description || t("chat.startConversation")}
          </div>
        </div>
      )}
      {items.map((item, i) => {
        const { visible, newDay } = rows[i];
        if (!visible) return null;
        if (item.kind === "run") {
          const first = item.messages[0];
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages
                  .filter((step) => showToolCalls || step.tool?.ok === false)
                  .map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityStep message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "compaction":
              return <ContextCompactionDivider message={m} />;
            case "secret":
              return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options":
              // a live permission ask gets the approval box; questions keep
              // the list card. The first-run quiz drops out once they talk.
              if (m.card?.requestId && m.card.tool) {
                return <ApprovalCard bot={bot} message={m} />;
              }
              if (shouldHideOnboardingCard(m, transcript)) return null;
              return <OptionCard botId={bot.id} message={m} />;
            case "routine.run": {
              const executionThreadId = m.routineRun?.executionThreadId;
              const canOpen = hasRoutineExecutionTask(bot.tasks, executionThreadId);
              return (
                <RoutineRunCard
                  message={m}
                  onOpen={canOpen
                    ? () => openNotificationTarget(
                        dispatch,
                        { botId: bot.id, threadId: executionThreadId },
                        state,
                      )
                    : undefined}
                />
              );
            }
            case "activity": {
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips stay because they link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool?.name.startsWith("error:")) {
                return (
                  <ErrorRow
                    message={m.tool.name.slice(6).trim()}
                    onRetry={m.id === canonicalLastMessageId && canRetryLast ? onRegenerate : undefined}
                    setupInstance={m.tool.setup ? engine : undefined}
                    usageLimit={m.tool.usageLimit}
                  />
                );
              }
              if (!activityVisibleInChat(m, showToolCalls)) return null;
              return <ActivityChip message={m} />;
            }
            case "screen":
              if (m.image) return <ShownImage name={m.image} caption={m.text} />;
              if (m.png) return <ScreenFrame src={`data:${m.mime ?? "image/png"};base64,${m.png}`} caption={m.text} />;
              return m.hasImage ? <ScreenFrame src={screenImageUrl(bot.threadId, m.id)} caption={m.text} /> : null;
            case "note":
              return <NoteMessage message={m} />;
            case "launch":
              return <LaunchMessage message={m} livePanes={livePanes} onOpenTerminalPane={onOpenTerminalPane} />;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  transcript={transcript}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  streaming={m === streamingMessage}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={onReply}
                  onFocusComposer={onFocusComposer}
                />
              );
          }
        })();
        if (!row) return null;
        // The parent identifies a reply slot before the server assigns its message id.
        const key = m.role === "bot" && m.kind === "text"
          ? `reply:${bot.threadId}:${m.parentId ?? transcript[transcript.indexOf(m) - 1]?.id ?? ""}`
          : m.sendId ?? m.id;
        return (
          <div key={key} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
export function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Pick<Bot, "name" | "threadId" | "hasMore">;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin: () => void;
}) {
  const { t } = useI18n();
  const pinned = useThreadMessage(
    bot.threadId,
    bot.hasMore ? pinnedId : undefined,
    messages.find((m) => m.id === pinnedId),
  );
  if (!pinned || pinned.kind !== "text") return null;
  const sender =
    pinned.role === "user" ? t("chat.you") : (pinned.from?.name ?? bot.name);
  const text = splitAttachedImages(pinned.text ?? "").display.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("chat.jumpToPinned")}
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        <button
          onClick={onUnpin}
          aria-label={t("chat.unpinMessage")}
          title={t("chat.unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export function ChatView({ bot, focusComposerBlocked = false, onOpenTerminal, onOpenTerminalPane }: { bot: Bot; focusComposerBlocked?: boolean; onOpenTerminal?: () => void; onOpenTerminalPane?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const sidebarOnRight = useSidebarSide() === "right";
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const focusComposer = useCallback(() => {
    focusComposerOnActivation({ composer: composerInputRef.current });
  }, []);

  const stream = useStreaming();
  const provisioning = state.provisioning[bot.id];
  const activeTask = bot.tasks?.find((task) => task.threadId === bot.threadId);
  const engine = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const callAvailable =
    capabilitiesReady && capabilities.dictation.available && Boolean(window.ogb?.speechStart);
  const elsewhere = routineWorkingElsewhere(
    bot.threadId,
    activeRunForBot(state.routineRuns, bot.id),
  );
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if (focusComposerBlocked) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [focusComposerBlocked]);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const accepted = state.acceptedSends[bot.threadId];
  const pending = state.pendingQueued[bot.threadId];
  const canonicalMessages = useMemo(() => visibleMessages(bot), [bot]);
  const messages = useMemo(() => withAcceptedMessages(canonicalMessages, accepted, pending), [canonicalMessages, accepted, pending]);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  // an old jump shows its own window; the live pages below keep taking arrivals
  const jump = useJumpWindow(dispatch, transcriptKey, bot.threadId, bot.messages, bot.activeLeafId, state.olderPatches[bot.threadId], state.snapshots);
  const shown = jump.messages ?? messages;
  const showToolCalls = showToolCallsEnabled(state.config);
  const renders = useCallback(
    (index: number) => messageVisible(messages[index], { showToolCalls, transcript: messages }),
    [messages, showToolCalls],
  );
  // `expanded`: the reader asked for scrollback, so the followed tail never slides it away.
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
    expanded?: boolean;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
  }
  // The window is index-based, so an older page landing on top shifts it.
  const loadOlder = useOlderMessages(dispatch, bot.threadId, bot.messages[0]?.id, bot.hasMore);
  const revealOlder = useRef(false);
  // the window's first row, so a snapshot that replaces the head can re-anchor by id
  const windowAnchor = useRef<{ id?: string; index: number }>({ index: 0 });
  const [seenSnapshot, setSeenSnapshot] = useState(state.snapshots);
  const [reanchor, setReanchor] = useState<string | null>(null);
  const rehydrated = seenSnapshot !== state.snapshots;
  if (rehydrated) setSeenSnapshot(state.snapshots);
  const head = shown[0]?.id;
  const [windowHead, setWindowHead] = useState(head);
  if (windowHead !== head) {
    setWindowHead(head);
    const prepended = windowHead ? shown.findIndex((message) => message.id === windowHead) : -1;
    // a window set on an empty branch has no rows to anchor to
    if (!windowHead) {
      setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
    } else if (prepended > 0) {
      const reveal = revealOlder.current;
      revealOlder.current = false;
      setTranscriptWindow((w) => shiftForPrepend(w, prepended, reveal));
    } else if (prepended < 0) {
      const { id, index } = windowAnchor.current;
      const at = id ? shown.findIndex((message) => message.id === id) : -1;
      if (at >= 0) setTranscriptWindow((w) => shiftForPrepend(w, at - index, false));
      // a plain tail's first row is not where the reader is; only scrollback they asked for re-anchors
      else if (rehydrated && id && transcriptWindow.key === transcriptKey && (transcriptWindow.expanded || transcriptWindow.end !== null)) {
        // the reader's row is older than the new snapshot: reopen around it
        setReanchor(id);
        setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
      }
    }
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(shown, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [shown, transcriptWindow.start, transcriptWindow.end],
  );
  useLayoutEffect(() => {
    windowAnchor.current = { id: windowedMessages[0]?.id, index: startIndex };
  });

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  // An edit in a jump window forks off an old parent: back to the tail, paging until the parent lands.
  const [editJoin, setEditJoin] = useState<{ key: string; parentId: string } | null>(null);
  const joinFails = useRef(0);
  const [joinRetry, setJoinRetry] = useState(0);
  const { close: closeJump } = jump;
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      const edited = jump.messages?.find((message) => message.id === messageId);
      if (edited) {
        closeJump();
        setBottomFollow(true);
        setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
        if (edited.parentId) {
          joinFails.current = 0;
          setEditJoin({ key: transcriptKey, parentId: edited.parentId });
        }
      }
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, closeJump, dispatch, jump.messages, messages.length, renders, setBottomFollow, transcriptKey],
  );
  const lastUserMessage = useMemo(
    () => [...canonicalMessages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [canonicalMessages],
  );
  // The selected leaf, or the prompt behind a long tool run, can sit on an
  // older page. Page back until the leaf lands; the prompt gets a few pages.
  const leafPaging = Boolean(bot.hasMore) && canonicalMessages.length === 0 && !jump.messages && !jump.pending;
  const promptPaging = Boolean(bot.hasMore) && Boolean(canonicalMessages[0]?.parentId) && !lastUserMessage;
  const joinPaging = editJoin?.key === transcriptKey && Boolean(bot.hasMore) && !bot.messages.some((message) => message.id === editJoin.parentId);
  // another view's join is kept; it resumes when its conversation is shown again
  if (editJoin?.key === transcriptKey && !joinPaging) setEditJoin(null);
  const promptPages = useRef({ key: transcriptKey, cursors: new Set<string>() });
  const cursor = bot.messages[0]?.id;
  useEffect(() => {
    if (leafPaging) {
      loadOlder();
      return;
    }
    if (joinPaging) {
      loadOlder(
        () => (joinFails.current = 0),
        () => {
          if (++joinFails.current < JOIN_TRIES) setTimeout(() => setJoinRetry((n) => n + 1), JOIN_RETRY_MS);
        },
      );
      return;
    }
    if (!promptPaging || !cursor) return;
    if (promptPages.current.key !== transcriptKey) promptPages.current = { key: transcriptKey, cursors: new Set() };
    const { cursors } = promptPages.current;
    if (!cursors.has(cursor) && cursors.size >= PROMPT_PAGES) return;
    cursors.add(cursor);
    loadOlder();
  }, [leafPaging, joinPaging, joinRetry, promptPaging, loadOlder, cursor, transcriptKey]);

  // Stream buffers belong to the canonical tail, never an optimistic send.
  const lastMessage = canonicalMessages.at(-1);
  const live = buffersForTurn(stream, bot.threadId, lastMessage?.id);
  const streaming = live.streaming;
  const reasoning = live.reasoning;
  // Stage transitions (Preparing -> Waiting -> Reconnecting) swap presence
  // content while messages, buffers and busy stay put, so the pin watches it.
  const turnSignal = stream.signal[bot.threadId];
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = turnStageLabel(
    turnPhase({ signal: stream.signal[bot.threadId], lastMessage, streaming, reasoning }),
    liveActivityLabel(lastMessage, showToolCalls),
  );
  const waiting = turnPresenceWaiting({
    busy: bot.busy,
    turnActive: turnSignal !== undefined,
    activity: bot.activity,
    lastMessage,
    accepted: state.acceptedSends[bot.threadId],
  });
  const streamingMessage = useMemo<Message | null>(() => waiting && streaming ? {
    id: `stream:${bot.threadId}:${lastMessage?.id ?? ""}`,
    parentId: lastMessage?.id,
    role: "bot",
    kind: "text",
    text: streaming,
    at: lastMessage?.at ?? 0,
    placeholder: true,
  } : null, [waiting, streaming, bot.threadId, lastMessage?.id, lastMessage?.at]);

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  useEffect(() => setBottomFollow(true), [transcriptKey, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  const requestedFocus = useRef<number | null>(null);
  const { open: openJump } = jump;
  useEffect(() => {
    if (!reanchor) return;
    setReanchor(null);
    if (!followRef.current && bot.hasMore) dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: reanchor });
  }, [reanchor, bot.hasMore, bot.threadId, dispatch]);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const liveIndex = messages.findIndex((message) => message.id === focus.messageId);
    const list = liveIndex >= 0 ? messages : shown;
    const targetIndex = liveIndex >= 0 ? liveIndex : shown.findIndex((message) => message.id === focus.messageId);
    // older than every loaded page: fetch one window around it
    if (targetIndex < 0) {
      if (bot.hasMore && requestedFocus.current !== focus.nonce) {
        requestedFocus.current = focus.nonce;
        openJump(focus.messageId);
      }
      return;
    }
    appliedFocus.current = focus.nonce;
    if (liveIndex >= 0) closeJump();
    const range = focusWindowRange(list.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, bot.hasMore, closeJump, messages, openJump, setBottomFollow, shown, state.focusMessage, transcriptKey]);
  const focusPaging =
    Boolean(bot.hasMore) &&
    state.focusMessage?.threadId === bot.threadId &&
    !shown.some((message) => message.id === state.focusMessage?.messageId);
  useFocusMessage(bot.threadId, shown.length > 0 && !focusPaging);
  useEffect(() => {
    if (!follow || jump.messages || transcriptWindow.end !== null || transcriptWindow.expanded) return;
    const start = followedTailStart(transcriptWindow.start, messages.length, TRANSCRIPT_WINDOW_SIZE, renders);
    if (start !== transcriptWindow.start) setTranscriptWindow((w) => ({ ...w, start }));
  }, [follow, jump.messages, messages.length, renders, transcriptWindow.start, transcriptWindow.end, transcriptWindow.expanded]);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted: flipping it true used to yank the
  // viewport to the end. Re-pinning only arms future content; Jump to latest
  // and this effect on new rows do the scrolling. The one exception is the
  // user's own send, which re-anchors via onSend even from scrollback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, turnSignal, bot.busy, composerDock.pad]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el || !followRef.current) return;
      el.scrollTo({ top: el.scrollHeight });
      previousScrollTop.current = el.scrollTop;
    });
    observer.observe(content);
    // a growing composer shrinks the viewport; re-pin before paint
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    if (startIndex === 0) {
      revealOlder.current = true;
      setTranscriptWindow((w) => ({ ...w, expanded: true }));
      (jump.messages ? jump.older : loadOlder)(() => {
        preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
      });
      return;
    }
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start, expanded: true }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start, head]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(shown.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= shown.length ? null : nextEnd }));
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    closeJump();
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        className={cn(
          // @container so the chips on the right can fold to icon bubbles
          // when the column is narrow (side panel open, small window)
          // py-1.5 below md: the 48px avatar row is the tallest of these headers,
          // so it needs the tighter padding to land on the shared 60px row.
          "@container/chathead flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 max-md:flex-nowrap max-md:py-1.5",
          // Room for the drawer button, which overlays this corner below md.
          sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-lg px-1.5 py-1 max-md:flex-[1_0_auto]">
          <button
            data-orbit-chat-focus-fallback=""
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-raised/50"
            title={t("chat.openProfile", { name: bot.name })}
            aria-label={t("chat.openProfile", { name: bot.name })}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages })}
              size={28}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </button>
          <div className="min-w-0 flex-1 overflow-hidden max-md:hidden">
            <RenameTitle
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onActivate={() => dispatch({ type: "toggleSettings", open: true })}
              showEditButton
              className="truncate text-[15px] font-semibold text-ink"
              inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
            />
          </div>
          <DeviceTag />
          {bot.chiefOfStaff && (
            <span
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent max-md:hidden"
              title={t("chrome.chiefOfStaff")}
              aria-label={t("chrome.chiefOfStaff")}
            >
              <Crown size={11} aria-hidden="true" /> <span className="@max-xs/chathead:sr-only">{t("chrome.chiefOfStaff")}</span>
            </span>
          )}
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary max-md:hidden" />}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2 max-md:min-w-0 max-md:shrink max-md:flex-nowrap">
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              aria-label={t("terminal.open")}
              title={`${t("terminal.open")} (${window.ogb?.platform === "darwin" ? "⌘" : "Ctrl+"}\`)`}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <TerminalSquare size={18} />
            </button>
          )}
          <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label={t("chat.findInConversation")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised max-md:hidden",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findInConversation")}
          >
            <Search size={18} />
          </button>
          {showBotNewTaskControl() && <TaskPicker bot={bot} />}
          <ModelPicker bot={bot} className="max-md:min-w-0" />
          {callAvailable && <CallButton bot={bot} />}
          {showComputerPanelChrome() && (
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            aria-label={t("chat.botComputer")}
            aria-pressed={state.computerOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.botComputer")}
          >
            <Monitor size={18} aria-hidden="true" />
          </button>
          )}
        </div>
      </div>

      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      {/* Error banner */}
      {state.error && (
        <div className="w-full px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {elsewhere && (
        <div className="w-full px-5">
          <div
            role="status"
            className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5"
          >
            <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
            <p className="min-w-0 flex-1 text-[12.5px] text-ink">
              {elsewhere.status === "queued"
                ? t("chat.routineQueuedElsewhere", { name: elsewhere.name })
                : elsewhere.status === "waiting"
                  ? t("chat.routineWaitingElsewhere", { name: elsewhere.name })
                  : t("chat.routineRunningElsewhere", { name: elsewhere.name })}
            </p>
            {elsewhere.threadId && (
              <button
                type="button"
                onClick={() => {
                  const threadId = elsewhere.threadId;
                  if (!threadId) return;
                  dispatch({ type: "switchTask", botId: bot.id, threadId });
                }}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10"
              >
                {t("chat.openRoutineThread")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={() =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { pinnedMessageId: "" } })
        }
      />

      {showToolCallsEnabled(state.config) && <TaskTimeline messages={messages} busy={bot.busy ?? false} />}

      {/* Overlay chrome + composer stack in-flow so 600x480 cannot cover chat. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-orbit-transcript
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume) setBottomFollow(true);
        }}
        onClick={(e) => {
          if (focusComposerBlocked || findOpen) return;
          if (!shouldFocusComposerOnTranscriptClick(e.target, e, window.getSelection()?.isCollapsed ?? true, e.currentTarget)) return;
          focusComposer();
        }}
      >
        <div
          ref={contentRef}
          className={cn("flex w-full flex-col gap-3 px-5", CHAT_COLUMN_CLASS)}
          style={{ paddingBottom: TRANSCRIPT_GAP }}
          role="log"
          aria-live="polite"
          aria-label={t("chat.conversationAria", { name: bot.name })}
        >
          {(hiddenCount > 0 || (jump.messages ? jump.hasMore : bot.hasMore)) && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show earlier messages{hiddenCount > 0 && ` (${hiddenCount} more)`}
              </button>
            </div>
          )}
          <MessagesList
            bot={bot}
            messages={windowedMessages}
            transcript={shown}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            canonicalLastMessageId={lastMessage?.id}
            streamingMessage={laterCount === 0 && !jump.messages ? streamingMessage : null}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={engine}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onReply={selectReply}
            onFocusComposer={focusComposer}
            onOpenTerminalPane={onOpenTerminalPane}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show later messages ({laterCount} more)
              </button>
            </div>
          )}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {/* Keyed by thread: the exit fade must not linger into the next transcript. */}
          <TurnPresence
            key={bot.threadId}
            avatar={
              <BotAvatar
                bot={bot}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={waiting && !jump.messages}
            label={activityLabel}
          />
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {(!follow || jump.messages) && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatest")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      {/* Keyed by task: each conversation keeps its own draft and a failed
          request can restore the old task without spilling into the newly
          selected one. ArrowUp-to-edit stays gated on busy because editing
          rewinds the thread, which a live turn forbids (the server 409s it). */}
      <div ref={composerDockRef} className={cn("relative z-[2] w-full shrink-0", CHAT_COLUMN_CLASS)}>
        <TaskRecoveryCard
          key={`${bot.id}:${activeTask?.threadId ?? bot.threadId}`}
          bot={bot}
          packet={activeTask?.taskState}
          turns={activeTask?.usage?.turns ?? 0}
        />
        <ChatPlanMeters
          windows={engine?.rateLimits?.windows}
          onOpenUsage={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
        />
        <Composer
          key={bot.threadId}
          bot={bot}
          composerRef={composerInputRef}
          onSend={jumpToLatest}
          focusBlocked={focusComposerBlocked}
          replyTo={replyTo}
          onClearReply={clearReply}
          onConsumeReply={consumeReply}
          onRestoreReply={restoreReply}
          onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
        />
      </div>
      </div>

    </main>
  );
}
