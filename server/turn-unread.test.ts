import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import * as turnReply from "./turn-reply.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

function compile(body: string, deps: Record<string, unknown>) {
  const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `{${javascript}}`)(...Object.values(deps));
}

function rig(target: "bot" | "group") {
  const messages: Message[] = [];
  const state = { unread: false, busyBotId: "bot-1" as string | null };
  const store = {
    messagesFor: () => messages,
    bot: () => ({ busy: false }),
    group: () => state,
    groupByThread: () => ({ id: "group-1", busyBotId: state.busyBotId }),
    setActivity: () => {},
    patchBot: (_id: string, patch: Partial<typeof state>) => Object.assign(state, patch),
    patchGroup: (_id: string, patch: Partial<typeof state>) => Object.assign(state, patch),
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => Object.assign(messages.find((m) => m.id === id)!, patch),
  };
  const fold = find(parsed, (node) => ts.isSwitchStatement(node)
    && node.expression.getText(parsed) === "event.type"
    && node.getText(parsed).includes("const settledReply = lastReply.get(event.threadId)")) as ts.SwitchStatement;
  const completed = fold.caseBlock.clauses.find((clause) => ts.isCaseClause(clause)
    && clause.expression.getText(parsed) === '"turn.completed"')!;
  const started = fold.caseBlock.clauses.find((clause) => ts.isCaseClause(clause)
    && clause.expression.getText(parsed) === '"turn.started"');
  const tracker = parsed.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === "unreadTurns"));
  const botUnread = find(completed, (node) => ts.isIfStatement(node)
    && node.thenStatement.getText(parsed) === 'store.patchBot(bot.id, { unread: true });')!;
  const groupUnread = find(completed, (node) => ts.isExpressionStatement(node)
    && node.getText(parsed).startsWith("store.patchGroup(group.id, { busyBotId: null,"))!;
  const decision = find(completed, (node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === "addedMessage"));
  const summaries = find(completed, (node) => ts.isForOfStatement(node)
    && node.getText(parsed).includes("turnSummary.settle"))!;
  const release = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "releaseInterruptedBot")!;
  const roomTurn = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "runClaimedGroupMemberTurn")!;
  const roomStart = find(roomTurn, (node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === "messagesAtStart"));
  const roomFallback = find(roomTurn, (node) => ts.isIfStatement(node)
    && node.expression.getText(parsed) === "store.group(group.id)?.busyBotId === bot.id")!;
  const deps: Record<string, unknown> = {
    ...turnReply, store, bot: { id: "bot-1" }, group: { id: "group-1" },
    routineReportGroup: undefined, turnSummary: turnReply.turnSummaries(),
    threadId: "thread-1", stopScreenPoller: () => {}, activeVpsThreads: new Map(), groupSpeakers: new Map(),
  };
  if (tracker) deps.unreadTurns = compile(`${tracker.getText(parsed)}\nreturn unreadTurns;`, deps);
  let turn = 0;
  return {
    state,
    start(runtime = true) {
      deps.event = { threadId: "thread-1", turnId: `turn-${++turn}` };
      state.busyBotId = "bot-1";
      if (roomStart) deps.messagesAtStart = compile(`${roomStart.getText(parsed)}\nreturn messagesAtStart;`, deps);
      if (runtime && started) compile(started.statements.filter((node) => !ts.isBreakStatement(node)).map((node) => node.getText(parsed)).join("\n"), deps);
    },
    append(message: Omit<Message, "id" | "at">) {
      const full = { id: `message-${messages.length}`, at: 1, ...message };
      messages.push(full);
      if (message.kind === "text") {
        (deps.turnSummary as ReturnType<typeof turnReply.turnSummaries>).note("thread-1", `turn-${turn}`, full.id, Boolean(message.summarized));
      }
    },
    settle() {
      compile([summaries, decision, target === "bot" ? botUnread : groupUnread].filter(Boolean).map((node) => node!.getText(parsed)).join("\n"), deps);
    },
    interrupt() {
      compile(`${release.getText(parsed)}\nreleaseInterruptedBot(bot.id, threadId);`, deps);
    },
    fallback() {
      compile(roomFallback.getText(parsed), deps);
    },
  };
}

const visible: Array<[string, Omit<Message, "id" | "at">]> = [
  ["final reply", { role: "bot", kind: "text", text: "Done." }],
  ["mid-turn line with an empty final", { role: "bot", kind: "text", text: "The check passed." }],
  ["file attachment", { role: "bot", kind: "text", text: '<attached-file path="/tmp/report.txt" />' }],
  ["image attachment", { role: "bot", kind: "screen", image: "result.png", shown: true }],
  ["screen frame", { role: "bot", kind: "screen", png: "pixels", mime: "image/png" }],
  ["question card", { role: "bot", kind: "options", card: { title: "Choose", subtitle: "Continue?", options: ["Yes", "No"] } }],
  ["connector card", { role: "bot", kind: "connector", connector: { slug: "github", label: "GitHub", description: "Connect", status: "required", resumeKey: "request-1" } }],
  ["credential card", { role: "bot", kind: "secret", secret: { target: "xaiApiKey", label: "API key", description: "Connect", placeholder: "Key", helpUrl: "https://example.com", requestKey: "request-1" } }],
  ["routine output", { role: "bot", kind: "routine.run", text: "Routine completed." }],
  ["promoted summary", { role: "bot", kind: "text", text: "Checked the report.", summarized: true }],
  ["turn error", { role: "bot", kind: "activity", tool: { name: "error: turn failed", ok: false } }],
  ["peer reply", { role: "bot", kind: "activity", text: "The peer replied.", tool: { name: "Reply from @Peer" }, comm: { groupId: "peer-room", withBotId: "peer", withName: "Peer", withColor: "blue", peer: "reply" } }],
  ["memory confirmation", { role: "bot", kind: "activity", tool: { name: "memory.save", spoken: "Saved your preference.", ok: true } }],
];

describe.each(["bot", "group"] as const)("%s turn unread", (target) => {
  it("preserves unread after an empty turn and a tool-only turn", () => {
    const r = rig(target);
    for (const unread of [false, true]) {
      r.state.unread = unread;
      r.start();
      r.settle();
      expect(r.state.unread).toBe(unread);
      r.start();
      r.append({ role: "bot", kind: "activity", tool: { name: "Read", ok: true } });
      r.append({ role: "bot", kind: "text", text: " \n" });
      r.settle();
      expect(r.state.unread).toBe(unread);
      if (target === "group") expect(r.state.busyBotId).toBeNull();
    }
  });

  it.each(visible)("marks a %s unread without leaking into the next turn", (_label, message) => {
    const r = rig(target);
    r.start();
    r.append(message);
    if (_label === "mid-turn line with an empty final") r.append({ role: "bot", kind: "text", text: "" });
    r.settle();
    expect(r.state.unread).toBe(true);
    r.state.unread = false;
    r.start();
    r.settle();
    expect(r.state.unread).toBe(false);
  });

  it("ignores old replies, user sends, and compaction records", () => {
    const r = rig(target);
    r.append({ role: "bot", kind: "text", text: "Previous reply." });
    r.start();
    r.append({ role: "user", kind: "text", text: "A queued instruction." });
    r.append({ role: "bot", kind: "compaction", compaction: {} });
    r.settle();
    expect(r.state.unread).toBe(false);
  });
});

describe("group unread fallbacks", () => {
  it.each(["interrupt", "fallback"] as const)("keeps a quiet %s read and a visible reply unread", (finish) => {
    const r = rig("group");
    r.start(finish === "interrupt");
    r.append({ role: "bot", kind: "activity", tool: { name: "Read", ok: true } });
    r[finish]();
    expect(r.state.unread).toBe(false);
    expect(r.state.busyBotId).toBeNull();
    r.start(finish === "interrupt");
    r.append({ role: "bot", kind: "text", text: "The result is ready." });
    r[finish]();
    expect(r.state.unread).toBe(true);
  });
});
