import type { IncomingMessage, ServerResponse } from "node:http";

import { readAttachment } from "./attachments.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, type AppConfig } from "./config.ts";
import { paneNoteText } from "./context-compaction.ts";
import type { RequestOutcome } from "./contracts.ts";
import { readDecisions } from "./decision-log.ts";
import { json, readBody } from "./http-helpers.ts";
import { searchHaystack, searchMessages, searchSnippet } from "./message-db.ts";
import { resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import type { Message, Store } from "./store.ts";
import { readThreadEvents } from "./thread-events.ts";
import type { createThreadSyncV2Gate } from "./thread-sync-v2-gate.ts";
import { turnIndex } from "./turn-index.ts";

type ThreadRouteDeps = {
  cfg: AppConfig;
  threadSyncGate: ReturnType<typeof createThreadSyncV2Gate>;
  store: Store;
  pullSyncedThread: (threadId: string) => void | Promise<void>;
  DEFAULT_PAGE: number;
  pageSize: (raw: string | null) => number | null | undefined;
  clientMessage: (message: Message) => Message;
  messagePage: (threadId: string, limit: number | undefined, before?: string | null) => { messages: unknown[]; hasMore?: boolean };
  messageWindow: (threadId: string, messageId: string, limit: number) => { messages: unknown[]; hasMore: boolean } | null;
  answerRequest: (threadId: string, instanceId: string, requestId: string, behavior: "allow" | "deny" | "answer", message?: string, decidedFor?: { id: string; name: string }) => Promise<RequestOutcome>;
  requestBehavior: (value: unknown) => "allow" | "deny" | "answer" | null;
  resolveAndSendRoutine: (res: ServerResponse, args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string }) => boolean;
  approvalBus: ApprovalBus;
};

export function createThreadRoutes(deps: ThreadRouteDeps) {
  const {
    cfg,
    threadSyncGate,
    store,
    pullSyncedThread,
    DEFAULT_PAGE,
    pageSize,
    clientMessage,
    messagePage,
    messageWindow,
    answerRequest,
    requestBehavior,
    resolveAndSendRoutine,
    approvalBus,
  } = deps;
  let openThread: string | null = null;
  return {
    openThread: () => openThread,
    listMessages: async (res: ServerResponse, m: RegExpMatchArray, url: URL) => {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
      openThread = threadId;
      if (threadSyncGate.enabled) await pullSyncedThread(threadId);
      else pullSyncedThread(threadId);
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) return json(res, 400, { error: "before and around cannot be combined" });
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) return json(res, 404, { error: "no such message" });
        return json(res, 200, window);
      }
      // An unknown cursor must not silently answer with the newest page -
      // the client would paginate in a circle and never reach the top.
      if (before && !store.messagesFor(threadId).some((msg) => msg.id === before)) {
        return json(res, 404, { error: "no such message" });
      }
      return json(res, 200, messagePage(threadId, limit ?? DEFAULT_PAGE, before));
    },
    turns: async (res: ServerResponse, m: RegExpMatchArray) => {
      const threadId = m[1];
      if (!store.botByThread(threadId)) return json(res, 404, { error: "no such conversation" });
      if (threadSyncGate.enabled) await pullSyncedThread(threadId);
      else pullSyncedThread(threadId);
      return json(res, 200, turnIndex(store.activePath(threadId)));
    },
    messageImage: async (res: ServerResponse, m: RegExpMatchArray) => {
      // Same guard as the page route above, and for the same reason twice
      // over: an unknown id should 404 deliberately rather than by accident,
      // and `messagesFor` materialises and caches a ThreadState for whatever
      // it is handed. Without this, a client asking for images on ids that
      // do not exist grows the thread map for as long as it keeps asking.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        return json(res, 404, { error: "no such conversation" });
      }
      const message = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      const attachment = message?.image ? readAttachment(message.image) : null;
      const bytes = attachment?.bytes ?? (message?.png ? Buffer.from(message.png, "base64") : null);
      if (!bytes) return json(res, 404, { error: "no image on that message" });
      res.writeHead(200, {
        "content-type": attachment?.mime ?? message?.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        // a settled message's image never changes
        "cache-control": "private, max-age=31536000, immutable",
      });
      return res.end(bytes);
    },
    search: async (res: ServerResponse, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
      const threadId = url.searchParams.get("threadId")?.trim() || undefined;
      // in-chat find: the page after `before`, matched against what the chat's skin draws
      const before = threadId ? url.searchParams.get("before") || undefined : undefined;
      const chips = url.searchParams.get("view") === "chips";
      if (threadId && !store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      // whether each hit sits on its thread's visible branch - a click on
      // one that does not has to switch versions first (and only then)
      const activePaths = new Map<string, Set<string>>();
      const onActivePath = (threadId: string, messageId: string) => {
        let ids = activePaths.get(threadId);
        if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m) => m.id))));
        return ids.has(messageId);
      };
      const threadRows = new Map<string, Map<string, Message>>();
      const messageIn = (threadId: string, messageId: string) => {
        let rows = threadRows.get(threadId);
        if (!rows) threadRows.set(threadId, (rows = new Map(store.messagesFor(threadId).map((m) => [m.id, m]))));
        return rows.get(messageId);
      };
      const needle = q.trim().toLowerCase();
      const found = searchMessages(q, limit + 1, threadId, { before, chips });
      const hits = found.slice(0, limit)
        .map((hit) => {
          const bot = store.botByThread(hit.threadId);
          const group = bot ? undefined : store.groupByThread(hit.threadId);
          if (!bot && !group) return null;
          const active = onActivePath(hit.threadId, hit.messageId);
          const message = messageIn(hit.threadId, hit.messageId);
          const snippet = message ? searchSnippet(searchHaystack(clientMessage(message), chips), needle) : {};
          if (bot) {
            const task = store.taskByThread(bot.id, hit.threadId);
            return { ...hit, ...snippet, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
          }
          if (group) {
            const task = store.groupTaskByThread(group.id, hit.threadId);
            return { ...hit, ...snippet, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
          }
          return null;
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return json(res, 200, { hits, more: found.length > limit });
    },
    exportThread: async (res: ServerResponse, m: RegExpMatchArray, url: URL) => {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return json(res, 400, { error: "format must be markdown or json" });
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId).filter((message) => !message.summarized).map(clientMessage);
      if (format === "json") {
        // pixels stripped - an export is for reading and archiving, and a
        // base64 desktop frame is neither
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
      }
      const userName = cfg.profile?.name?.trim() || "User";
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const who = msg.role === "user" ? userName : (msg.from?.name ?? bot?.name ?? "Bot");
        if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
        else if (msg.kind === "activity" && msg.tool) lines.push(`> ${msg.tool.name}`, "");
        else if (msg.kind === "note" && msg.text) lines.push(paneNoteText(msg.text), "");
        else if (msg.kind === "screen") lines.push("> [screen capture]", "");
        else if (msg.kind === "options" && msg.card) {
          lines.push(`> ${msg.card.title}${msg.card.answered ? ` - answered: ${msg.card.answered}` : ""}`, "");
        }
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
      });
      return res.end(lines.join("\n"));
    },
    reaction: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) return json(res, 400, { error: "emoji required" });
      const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) return json(res, 404, { error: "no such message" });
      return json(res, 200, { message: patched });
    },
    respond: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const threadId = m[1];
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const requestId = String(body.requestId);
      const routineCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.routineRequest,
      );
      if (routineCard?.card?.routineRequest) {
        // Derive the owner from the conversation, not from the executable
        // payload being authorized. Room cards carry their trusted sender;
        // one-to-one tasks resolve through the store's thread ownership.
        const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!routineBotId) return json(res, 400, { error: "this routine request has no valid owner" });
        const routineOwner = store.bot(routineBotId);
        if (resolveAndSendRoutine(res, {
          botId: routineBotId,
          botName: routineOwner?.name,
          threadId,
          requestId,
          behavior,
        })) return;
      }
      // peer-approval intercept (see /api/bots/:id/respond above). A peer card
      // belongs to the bus rather than to a speaker, so resolve it before we go
      // looking for one - a room between turns has no speaker to find.
      if (resolvePeerComms(approvalBus, requestId, behavior)) {
        return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
      }
      const group = store.groupByThread(threadId);
      // busyBotId is in-memory only, so an approval that outlives its turn - or
      // the process - leaves a durable card with no speaker behind it. Fall back
      // to the member that raised it, and answer even when that member is gone:
      // answerRequest closes an unreachable card, and a pending approval owns
      // the composer, so a dead end here locks the room for good.
      const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
      const owner = group
        ? (group.busyBotId ? store.bot(group.busyBotId) : undefined) ??
          (pending?.from ? store.bot(pending.from.botId) : undefined)
        : store.botByThread(threadId);
      if (!owner && !pending) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
      const outcome = await answerRequest(threadId, owner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined);
      return json(res, 200, { ok: true, outcome });
    },
    events: async (res: ServerResponse, m: RegExpMatchArray, url: URL) => {
      const threadId = m[1];
      const known =
        store.bots.some((b) => store.tasks(b.id).some((t) => t.threadId === threadId)) ||
        Boolean(store.groupByThread(threadId));
      if (!known) return json(res, 404, { error: "no such thread" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const limit = parsedLimit;
      return json(res, 200, readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId, limit }));
    },
    decisions: async (res: ServerResponse, url: URL) => {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, { decisions: readDecisions(DATA_DIR, parsedLimit ?? 200) });
    },
  };
}
