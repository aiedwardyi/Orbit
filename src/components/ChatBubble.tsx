import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Clock, Copy, MessageSquareReply, Pencil, Pin, PinOff, RefreshCw, Webhook } from "lucide-react";
import { useStoreDispatch, formatDateTime, formatTime, type Bot, type Message } from "@/state/store";
import { DockedPresence, MessageBoundary, useDockFade, type ReplyDock } from "./TurnPresence";
import { ChatMarkdown } from "./ChatMarkdown";
import { ReplyQuote } from "./ReplyQuote";
import { AttachedImageGallery } from "./AttachmentPreview";
import { FileAttachmentRows } from "./FileAttachmentRow";
import { ReactionBar, ReactionChips } from "./Reactions";
import { contextClickKind, holdToOpen, isTouchPrimary, keepsNativeMenu, type MessageMenuRequest, type MessageMenuTarget } from "./MessageMenu";
import { cn } from "@/lib/cn";
import { useThreadMessage } from "@/lib/message-pages";
import { detectChatOptions } from "@/lib/chat-options";
import { ChatOptionChips } from "./ChatOptionChips";
import { PeerMessageBody } from "./PeerMessage";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { placeTooltip } from "@/lib/tooltip-position";
import { PLAIN_TOOLTIP_CLASS } from "@/lib/tooltips";
import { localeTag, useI18n } from "@/lib/i18n";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

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
            className={PLAIN_TOOLTIP_CLASS}
          >
            {full}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Bubble's bot fields, as primitives so a settled row's memo holds across appends. */
function bubbleBot(bot: Bot) {
  // the folder this task's turns run in: pinned once a turn ran, else the bot's own
  const pinnedFolder = bot.tasks?.find((task) => task.threadId === bot.threadId)?.cwd;
  return {
    botId: bot.id,
    threadId: bot.threadId,
    botName: bot.name,
    botFolder: pinnedFolder === undefined ? bot.cwd : pinnedFolder,
    busy: Boolean(bot.busy),
    hasMore: Boolean(bot.hasMore),
  };
}

const userVersions = new WeakMap<Message[], Map<string | null, Message[]>>();

/** Every fork a user message belongs to, oldest first, as primitives. */
function versionProps(messages: Message[], message: Message) {
  let byParent = userVersions.get(messages);
  if (!byParent) {
    byParent = new Map();
    for (const m of messages) {
      if (m.role !== "user" || m.kind !== "text") continue;
      const parent = m.parentId ?? null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), m]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.at - b.at);
    userVersions.set(messages, byParent);
  }
  const versions = message.role === "user" && message.kind === "text" ? (byParent.get(message.parentId ?? null) ?? []) : [message];
  const index = versions.findIndex((v) => v.id === message.id);
  return {
    versionIndex: index,
    versionCount: versions.length,
    prevVersionId: versions[index - 1]?.id,
    nextVersionId: versions[index + 1]?.id,
  };
}

const Bubble = memo(function Bubble({
  botId,
  threadId,
  botName,
  botFolder,
  busy,
  hasMore,
  pinned,
  message,
  laterAnswer = null,
  versionIndex,
  versionCount,
  prevVersionId,
  nextVersionId,
  editing,
  isLastBotText,
  streaming = false,
  dock,
  sendsNext = false,
  queuedActions,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
  onFocusComposer,
  onMessageMenu,
}: ReturnType<typeof bubbleBot> & ReturnType<typeof versionProps> & {
  pinned: boolean;
  message: Message;
  /** the first user text after this message, for an options reply */
  laterAnswer?: string | null;
  editing: boolean;
  isLastBotText: boolean;
  streaming?: boolean;
  dock?: ReplyDock;
  sendsNext?: boolean;
  queuedActions?: MessageMenuTarget["queued"];
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
  onFocusComposer: () => void;
  onMessageMenu: (menu: MessageMenuRequest) => void;
}) {
  const { t } = useI18n();
  const dispatch = useStoreDispatch();
  const quoted = useThreadMessage(threadId, hasMore ? message.replyToId : undefined, replyTarget);
  const members = useMemo(() => [{ id: botId, name: botName }], [botId, botName]);
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const dockShown = useDockFade(dock?.live ?? false) && Boolean(dock);
  const text = message.text ?? "";
  const detectedOptions = !user && !streaming && message.kind === "text" ? detectChatOptions(text) : null;
  const answeredChoice = detectedOptions ? laterAnswer : null;
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

  const hasReactions = !message.placeholder && Boolean(message.reactions?.length);
  // "‹ 2/3 ›" under an edited message
  const switchTo = (messageId: string | undefined) => {
    if (messageId && !busy) dispatch({ type: "switchBranch", botId, messageId });
  };

  const menuTarget =
    message.kind === "text" && (!message.placeholder || queuedActions)
      ? {
        threadId,
        message,
        copyText: user ? visibleText : text,
        user: user && !message.from,
        pinned,
        canPin: (user && !message.from) || (!streaming && !dock?.live),
        queued: queuedActions,
      }
      : null;

  const menuProps: HTMLAttributes<HTMLDivElement> = {
    ...holdToOpen(menuTarget && ((x, y, opener) => onMessageMenu({ kind: "message", x, y, opener, target: menuTarget }))),
    onContextMenu: menuTarget ? (e) => {
      if (isTouchPrimary() || !(e.target instanceof Element)) return;
      const kind = contextClickKind(e.target, e.clientX, e.clientY);
      if (kind === "native") return;
      e.preventDefault();
      e.stopPropagation();
      onMessageMenu(kind === "selection"
        ? { kind, x: e.clientX, y: e.clientY, opener: e.currentTarget, text: window.getSelection()?.toString() ?? "" }
        : { kind, x: e.clientX, y: e.clientY, opener: e.currentTarget, target: menuTarget });
    } : undefined,
    onKeyDown: menuTarget ? (e) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      if (e.target instanceof Element && keepsNativeMenu(e.target)) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onMessageMenu({
        kind: "message",
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        opener: e.currentTarget,
        target: menuTarget,
      });
    } : undefined,
  };

  // a teammate's message lands as a user row; it reads as theirs, like the asker side's
  if (user && message.from) {
    return (
      <div data-orbit-message="peer" className="group flex w-full flex-col items-start outline-none focus-visible:outline-2 focus-visible:outline-accent" tabIndex={0} {...menuProps}>
        <div className="orbit-message-speaker hidden">{message.from.name}</div>
        <div className={cn("relative w-full", hasReactions && "pb-8")}>
          <div data-orbit-message-content className="contents">
            {attachedImages && attachedImages.images.length > 0 && (
              <AttachedImageGallery paths={attachedImages.images} className="ml-3 max-w-[min(42rem,78%)] justify-start pl-3" />
            )}
            <PeerMessageBody text={visibleText} />
            {attachedImages && <FileAttachmentRows files={attachedImages.files} className="mt-2 ml-3 max-w-[min(42rem,78%)] pl-3" />}
          </div>
          {!message.placeholder && <ReactionChips threadId={threadId} message={message} members={members} corner="left" className="bottom-4 ml-3" />}
        </div>
        <TimestampLabel at={message.at} />
      </div>
    );
  }

  return (
    <div
      data-orbit-message={user ? "user" : "bot"}
      className={cn("group flex w-full flex-col outline-none", user ? "animate-msg-in items-end" : "items-start")}
      tabIndex={-1}
      {...menuProps}
    >
      {/* padded so the docked action row below the bubble
          keeps out of the timestamp and reaction chips that follow it */}
      <div
        data-orbit-message-body
        data-strip={hasReactions || dockShown ? "" : undefined}
        className={cn("relative w-fit max-w-[min(42rem,78%)]", hasReactions ? "pb-11" : "pb-8")}
      >
        <div className="orbit-message-speaker hidden">{user ? (message.from?.name ?? t("chat.you")) : botName}</div>
        {user && !message.placeholder && (
          <div
            data-message-hover-actions
            className="pointer-events-none absolute right-0 bottom-0 z-20 flex items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          >
            {/* editing rewinds the thread, so it waits for the turn to end —
                same rule as the version switcher below */}
            {message.kind === "text" && !webhookView && !busy && (
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
                  botId,
                  patch: { pinnedMessageId: pinned ? "" : message.id },
                })
              }
              aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
              aria-pressed={pinned}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
        )}
        <div
          data-orbit-message-content
          className={cn(
            "w-fit max-w-full rounded-2xl text-[15px] leading-relaxed break-words",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "bg-card px-4 py-2.5 text-ink",
          )}
        >
          {quoted && (
            <div className="mb-2">
              <ReplyQuote
                message={quoted}
                fallbackName={botName}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId, messageId: quoted.id })
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
              {attachedImages && <FileAttachmentRows files={attachedImages.files} className={cn(visibleText && "mt-2")} />}
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title={t("chat.sentMidTurnHint")}>
                  {t("chat.sentMidTurn")}
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFullMessage")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : markdownText.trim() ? (
            <MessageBoundary fallbackText={markdownText}>
              <ChatMarkdown text={markdownText} streaming={streaming} whole={message.streamWhole} baseDir={botFolder} threadId={threadId} />
            </MessageBoundary>
          ) : null}
        </div>
        {dock && dockShown && <DockedPresence avatar={dock.avatar} label={dock.label} live={dock.live} since={dock.since} className="absolute bottom-0 left-0 h-[26px]" />}
        {!user && !streaming && !dock?.live && (
          <div
            data-message-hover-actions
            // left, not right: the row is wider than a short bot bubble, and
            // the wrapper is w-fit, so right-0 would grow it off the left edge
            className="pointer-events-none absolute bottom-0 left-0 z-20 flex items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100"
          >
            {message.kind === "text" && <ReactionBar threadId={threadId} message={message} />}
            <CopyButton text={text} className="opacity-100" />
            {isLastBotText && !busy && onRegenerate && (
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
                  botId,
                  patch: { pinnedMessageId: pinned ? "" : message.id },
                })
              }
              aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
              aria-pressed={pinned}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
        )}
        {!message.placeholder && (
          <ReactionChips
            threadId={threadId}
            message={message}
            members={members}
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
          disabled={!answeredChoice && busy}
          onPick={(option) => dispatch({ type: "send", botId, text: option })}
          onWriteOwn={onFocusComposer}
        />
      )}
      <TimestampLabel at={message.at} hidden={streaming} />
      {sendsNext && (
        <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>{t("chat.queuedSendsNext")}</span>
        </div>
      )}
      {!message.placeholder && versionCount > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(prevVersionId)}
            disabled={versionIndex <= 0 || busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versionCount}
          </span>
          <button
            onClick={() => switchTo(nextVersionId)}
            disabled={versionIndex >= versionCount - 1 || busy}
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

export { Bubble, bubbleBot, versionProps };
