import type { MausMotion } from "@/lib/mascot";
import type { NotificationTarget } from "@/lib/notify";
import { isShownMessage } from "@/lib/shown-message";
import type { AppState, Bot, ConfigStatus, ConfigStatusFrame, Group, Message, ModelSelection, NotificationRoutingState, OptionCardData, QueueReceiptSnapshot, TerminalAttention, TerminalAttentionMap } from "./store-types";

/** What the UI shows as chosen: a mid-reply pick wins over the running model. */
export const shownModelSelection = (bot: Pick<Bot, "modelSelection" | "pendingModelSelection">): ModelSelection =>
  bot.pendingModelSelection ?? bot.modelSelection;

export function terminalAttentionKey(botId: string, sessionId: string): string {
  return `${botId}:${sessionId}`;
}

export function terminalAttentionForBot(attention: TerminalAttentionMap, botId: string): TerminalAttention | null {
  let latest: TerminalAttention | null = null;
  for (const candidate of Object.values(attention)) {
    if (candidate.botId !== botId || (latest && candidate.receivedAt < latest.receivedAt)) continue;
    latest = candidate;
  }
  return latest;
}

export function terminalAttentionCount(attention: TerminalAttentionMap): number {
  return Object.keys(attention).length;
}

function walkVisible(messages: Message[], leafId: string, hasMore: boolean): Message[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  // a paged leaf lives on an older page; the loaded rows may be another branch
  if (!byId.has(leafId)) return hasMore ? [] : messages;
  const path: Message[] = [];
  const seen = new Set<string>();
  let cur = byId.get(leafId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

function messageIsAncestor(messages: readonly Message[], childId: string, ancestorId: string): boolean {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  let current = byId.get(childId);
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    gemini: frame.gemini,
    openaiCompat: frame.openaiCompat,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    localVm: frame.localVm,
    tts: frame.tts,
    imageGen: frame.imageGen,
    anthropic: frame.anthropic,
    vertex: frame.vertex,
    customKeys: frame.customKeys,
    profile: frame.profile,
    features: frame.features,
    browserProfiles: frame.browserProfiles,
  };
}

function holdStopping(
  state: AppState,
  reported: ReadonlyArray<{ id: string; busy?: boolean; activity?: Bot["activity"] }>,
): AppState {
  let next = state;
  for (const bot of reported) {
    const hold = next.stoppingBots[bot.id];
    if (!hold) continue;
    if (bot.busy === false) {
      const { [bot.id]: _released, ...stoppingBots } = next.stoppingBots;
      next = { ...next, stoppingBots };
      continue;
    }
    if (bot.busy === true) {
      next = { ...next, stoppingBots: { ...next.stoppingBots, [bot.id]: { ...hold, busy: true, activity: bot.activity } } };
    }
    next = updateBot(next, bot.id, (current) => ({
      ...current,
      busy: false,
      activity: current.activity === "working" ? "idle" : current.activity,
    }));
  }
  return next;
}

const MAX_CONSUMED_QUEUE_IDS = 64;

function rememberConsumedQueueId(
  consumed: AppState["consumedQueueIds"],
  queueId: string,
): AppState["consumedQueueIds"] {
  const next = { ...consumed, [queueId]: true as const };
  const overflow = Object.keys(next).length - MAX_CONSUMED_QUEUE_IDS;
  if (overflow > 0) {
    for (const id of Object.keys(next).slice(0, overflow)) delete next[id];
  }
  return next;
}

/** A replacement snapshot can contain the canonical user line after this
 * window missed its queue-drain frame. Remove any matching chip and retain a
 * short tombstone so a slower POST continuation cannot add the chip back. */
function reconcileSnapshotQueues(
  state: AppState,
  conversations: QueueReceiptSnapshot[],
): AppState {
  const landed: Array<{ queueId: string; at: number }> = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      if (message.queueId) landed.push({ queueId: message.queueId, at: message.at });
    }
  }
  if (landed.length === 0) return state;

  const landedIds = new Set(landed.map((entry) => entry.queueId));
  const pendingQueued: AppState["pendingQueued"] = {};
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    const waiting = entries.filter((entry) => !landedIds.has(entry.queueId));
    if (waiting.length > 0) pendingQueued[threadId] = waiting;
  }

  let consumedQueueIds = state.consumedQueueIds;
  // Preserve the newest receipts when a large historical snapshot contains
  // more than the bounded tombstone window.
  landed.sort((left, right) => left.at - right.at);
  for (const entry of landed) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
  }
  return { ...state, pendingQueued, consumedQueueIds };
}

/** The exact conversation currently on screen. A focused window is not
 * enough to suppress an alert when its actionable card is in another task. */
export function visibleNotificationThread(
  state: NotificationRoutingState & Pick<AppState, "activeView" | "selectedId">,
): string | null {
  if (state.activeView !== "chat") return null;
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

/** A reply pulled from another PC is history, not a fresh answer. */
export function autoSpeaks(frame: { imported?: boolean; message?: { role?: string; text?: string; summarized?: boolean } }): boolean {
  return !frame.imported && Boolean(frame.message?.text?.trim() && isShownMessage(frame.message));
}

/** A conversation on an unfocused or hidden window is not being read, even
 * if it is the one on screen - an idle client watching over someone's
 * shoulder must not silently clear the badge the active device hasn't seen. */
export function shouldClearSelectedUnread(
  state: Pick<AppState, "activeView" | "selectedId" | "workspaceOpen">,
  owner: { id: string; unread?: boolean },
  windowActive: boolean,
): boolean {
  return Boolean(
    owner.unread &&
      windowActive &&
      state.activeView === "chat" &&
      !state.workspaceOpen &&
      state.selectedId === owner.id,
  );
}

// A room's approval/question notification carries the asker bot with the
// GROUP's thread id; asking the bot to switch to that thread would 404.
// Open the room itself. A thread that is neither a room nor one of the
// bot's own lands on a plain bot select instead of an error banner.
function notificationOwner(state: NotificationRoutingState, target: NotificationTarget) {
  return notificationGroup(state, target) ?? state.bots.find((candidate) => candidate.id === target.botId);
}

function notificationGroup(state: NotificationRoutingState, target: NotificationTarget) {
  return state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
  );
}

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

function patchGroupCard(state: AppState, groupId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === groupId
        ? { ...g, messages: g.messages.map((m) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m)) }
        : g,
    ),
  };
}

/** First-run quiz still sitting on this bot's thread. */
function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) =>
      message.kind === "options" && message.card && !message.card.requestId && !message.card.askUser && !message.card.dismissed,
  );
}

function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

function holdOlderPatch(state: AppState, conversation: Bot | Group, message: Message): AppState {
  if (!conversation.hasMore || conversation.messages.some((m) => m.id === message.id)) return state;
  const thread = { ...state.olderPatches[conversation.threadId], [message.id]: message };
  return { ...state, olderPatches: { ...state.olderPatches, [conversation.threadId]: thread } };
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

// base64 screen frames are big; a long computer-use history would grow memory
// without bound. Strip older pixels (the message row survives as a placeholder).
function keepNewestScreenFrames(messages: Message[]): Message[] {
  const withPng = messages.filter((m) => m.kind === "screen" && m.png && !m.shown);
  const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
  if (excess <= 0) return messages;
  const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
  return messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
}

/** Messages per conversation a reload paints before the live snapshot lands. */
const CACHED_TAIL_MESSAGES = 50;

function cachedTail(messages: Message[]): Message[] {
  return messages.slice(-CACHED_TAIL_MESSAGES).map((m) => (m.png ? { ...m, png: undefined } : m));
}

export { walkVisible, messageIsAncestor, holdStopping, rememberConsumedQueueId, reconcileSnapshotQueues, notificationOwner, notificationGroup, updateBot, withMascotMotion, patchCard, patchGroupCard, openOnboardingCard, dismissOnboardingCard, holdOlderPatch, keepNewestScreenFrames, cachedTail };
