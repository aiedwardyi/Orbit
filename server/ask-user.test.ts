// The ask_user endpoint: sender and thread checks, the marked card it posts,
// choice capping, and exactly one alert per question.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ASK_USER_QUESTION_MAX, askUserCardPatchSchema, askUserChoices, askUserRequestSchema, postAskUser, type AskUserDeps, type AskUserRequest } from "./ask-user.ts";
import type { MausColor, Message } from "./store.ts";

type Bot = { id: string; name: string; color: MausColor };

function harness(conversations = new Map<string, { group?: object }>([["bot-a:thread-a", {}]])) {
  const bots = new Map<string, Bot>([["bot-a", { id: "bot-a", name: "Ada", color: "teal" }]]);
  const appended: Array<{ threadId: string; message: Omit<Message, "id" | "at"> }> = [];
  const alerts: Array<{ bot: Bot; threadId: string; question: string }> = [];
  const deps: AskUserDeps<Bot> = {
    bot: (id) => bots.get(id),
    conversation: (botId, threadId) => conversations.get(`${botId}:${threadId}`) ?? null,
    appendMessage: (threadId, message) => {
      appended.push({ threadId, message });
      return { ...message, id: `m-${appended.length}`, at: 1 };
    },
    alertThread: (_bot, threadId) => threadId,
    notifyQuestion: (bot, threadId, question) => alerts.push({ bot, threadId, question }),
    whenSettled: (_botId, _threadId, post) => post(),
  };
  return { deps, appended, alerts };
}

const ask = (deps: AskUserDeps<Bot>, body: Partial<AskUserRequest>) => postAskUser(deps, askUserRequestSchema.parse(body));

describe("ask-user endpoint", () => {
  it("posts a marked question card into the sender's own thread and alerts once", () => {
    const h = harness();
    const res = ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "  Prod or staging?  ", choices: ["Prod", "Staging"] });
    expect(res).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(h.appended).toEqual([
      {
        threadId: "thread-a",
        message: {
          role: "bot",
          kind: "options",
          card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true },
        },
      },
    ]);
    expect(h.appended[0].message.card).not.toHaveProperty("requestId");
    expect(h.alerts).toEqual([{ bot: expect.objectContaining({ id: "bot-a" }), threadId: "thread-a", question: "Prod or staging?" }]);
  });

  it("attributes a room question to its sender", () => {
    const h = harness(new Map([["bot-a:room-1", { group: { id: "g1" } }]]));
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "room-1", question: "Which?" }).status).toBe(201);
    expect(h.appended[0].message.from).toEqual({ botId: "bot-a", name: "Ada", color: "teal" });
    expect(h.appended[0].message.card?.options).toEqual([]);
  });

  it("refuses unknown senders, foreign threads and empty questions without posting or alerting", () => {
    const h = harness();
    expect(ask(h.deps, { fromBotId: "ghost", fromThreadId: "thread-a", question: "x" })).toMatchObject({ status: 403, body: { error: "unknown sender" } });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "", question: "x" })).toMatchObject({ status: 400 });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-b", question: "x" })).toMatchObject({
      status: 403,
      body: { error: "source thread does not belong to sender" },
    });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "   " })).toMatchObject({ status: 400 });
    expect(h.appended).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("caps the question and trims, dedupes and caps the choices", () => {
    const h = harness();
    ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "q".repeat(ASK_USER_QUESTION_MAX + 50) });
    expect(h.appended[0].message.card?.subtitle).toHaveLength(ASK_USER_QUESTION_MAX);
    expect(askUserRequestSchema.parse({ choices: [" a ", "a", "", 4, "b", "c", "d", "e", "f"] }).choices).toHaveLength(9);
    expect(askUserChoices(askUserRequestSchema.parse({ choices: [" a ", "a", "", 4, "b", "c", "d", "e", "f"] }).choices)).toEqual(["a", "b", "c", "d", "e"]);
    expect(askUserRequestSchema.parse({ choices: "a,b" }).choices).toEqual([]);
    expect(askUserRequestSchema.parse("not an object")).toEqual({ fromBotId: "", fromThreadId: "", question: "", choices: [] });
  });

  it("is routed in the harness with the question alert and never sets waiting-on-you", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("./internal-routes.ts", import.meta.url), "utf8");
    const route = routes.slice(routes.indexOf("askUser: async ("));
    const handler = route.slice(0, route.indexOf("return json(res, result.status, result.body);"));
    expect(handler).toContain("conversation: connectorThread");
    expect(handler).toContain('buildNotification("question", bot, target, question)');
    expect(handler).toContain("routineSourceThread(run)");
    expect(handler).toContain("askHold.whenSettled(botId, threadId, post)");
    expect(source).toContain("askHold.flush();");
    expect(handler).not.toContain("waiting-on-you");
    const dispatch = source.slice(source.indexOf('if (method === "POST" && path === "/api/internal/ask-user")'));
    const guard = dispatch.slice(0, dispatch.indexOf("// terminal_spawn:"));
    expect(guard).toMatch(/^if \(method === "POST" && path === "\/api\/internal\/ask-user"\) \{\s+return await internalRoutes\.askUser\(req, res\);\s+\}\s+$/);
  });

  it("lets a room persist only an ask_user card's answered or dismissed state", () => {
    const source = readFileSync(new URL("./group-routes.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf("patchCard: async ("));
    const handler = route.slice(0, route.indexOf("return json(res, 200, { message: patched });"));
    expect(handler).toContain('if (!existing?.card?.askUser) return json(res, 404, { error: "no such card" });');
    expect(handler).toContain("askUserCardPatchSchema.parse(await readBody(req))");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const cards = index.slice(index.indexOf("m = path.match(/^\\/api\\/groups\\/([\\w-]+)\\/cards\\/([\\w-]+)$/);"));
    const guard = cards.slice(0, cards.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);"));
    expect(guard).toMatch(/^m = path\.match\(.+\);\s+if \(m && method === "PATCH"\) \{\s+return await groupRoutes\.patchCard\(req, res, m\);\s+\}\s+$/);
    expect(askUserCardPatchSchema.parse({ answered: "Prod", dismissed: "yes", requestId: "r1" })).toEqual({ answered: "Prod" });
    expect(askUserCardPatchSchema.parse({ dismissed: true })).toEqual({ dismissed: true });
  });
});
