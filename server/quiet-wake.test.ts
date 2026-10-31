import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";
import { createQuietWakeTurns } from "./quiet-wake.ts";
import { buildNotification } from "./notify.ts";
import { turnAddedMessage, turnSummaries } from "./turn-reply.ts";
import { isShownMessage } from "../src/lib/shown-message.ts";
import { prepareModelContext } from "./context-compaction.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function execute(code: string, deps: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}
const assistantFold = find(parsed, (node) => ts.isIfStatement(node)
  && node.expression.getText(parsed) === 'event.itemType === "assistant_text"'
  && node.thenStatement.getText(parsed).includes("const stamp = takePeerReplyStamp")) as ts.IfStatement;
const notification = find(parsed, (node) => ts.isCallExpression(node)
  && node.expression.getText(parsed) === "buildNotification"
  && node.getText(parsed).startsWith('buildNotification("done"'))!;
const routineSource = find(parsed, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "syncRoutineRunToSource")!;
const routineUnread = find(routineSource, (node) => ts.isIfStatement(node) && node.expression.getText(parsed).startsWith("statusChanged &&"))!;
const base = { eventId: "event", provider: "codex" as const, threadId: "thread", turnId: "turn", createdAt: "2026-10-31T00:00:00Z" };
const delta = (text: string): Extract<RuntimeEvent, { type: "content.delta" }> => ({ ...base, type: "content.delta", streamKind: "assistant_text", delta: text });

function rig(opts?: Parameters<ReturnType<typeof createQuietWakeTurns>["start"]>[1], folded: string[] = []) {
  const quietWakeTurns = createQuietWakeTurns();
  quietWakeTurns.start("thread", opts, folded);
  const messages: Message[] = [];
  const lastReply = new Map();
  return {
    messages, quietWakeTurns,
    reply(text: string, summarized = false) {
      const event = { ...base, type: "item.completed", itemType: "assistant_text", text, summarized };
      execute(assistantFold.thenStatement.getText(parsed), {
        event, quietWakeTurns, lastReply, peerReplyComm: new Map(), takePeerReplyStamp: () => undefined,
        turnSummary: turnSummaries(), markChatLatency: () => {},
        pushMessage: (row: Omit<Message, "id" | "at">) => {
          const message = { ...row, id: `m${messages.length}`, at: messages.length };
          messages.push(message);
          return message;
        },
      });
      return messages.at(-1)!;
    },
    notification(detail = lastReply.get("thread")?.text ?? "") {
      return execute(`return ${notification.getText(parsed)};`, {
        buildNotification, quietWakeTurns, bot: { id: "bot", name: "Scout", threadId: "thread" },
        event: base, routineReportThread: null, completionDetail: detail,
        reply: lastReply.get("thread")?.text ?? "", paneNoteTurnThreads: new Set(opts?.paneNoteWake ? ["thread"] : []),
      });
    },
  };
}

describe("quiet wakes", () => {
  it.each(["·", " \n·\t", "", " \n"])("hides a pane-note reply %j without changing its history", (text) => {
    const r = rig({ paneNoteWake: true });
    const message = r.reply(text);
    expect(message.text).toBe(text);
    expect(isShownMessage(message)).toBe(false);
    expect(turnAddedMessage(r.messages, 0)).toBe(false);
    expect(r.notification()).toBeNull();
  });

  it("does not count a worker dot as unread", () => {
    const r = rig({ paneNoteWake: true });
    r.reply("·");
    expect(turnAddedMessage(r.messages, 0)).toBe(false);
  });

  it.each([{ keepGoingWake: true }, { automationSource: "schedule" as const }])("silences a quiet scheduler reply %j, including routine fallback detail", (opts) => {
    const r = rig(opts);
    expect(isShownMessage(r.reply("·"))).toBe(false);
    expect(r.notification("Morning routine")).toBeNull();
  });

  it("does not announce a quiet scheduler reply", () => {
    const r = rig({ keepGoingWake: true });
    r.reply("·");
    expect(r.notification()).toBeNull();
  });

  it.each([undefined, {}])("keeps a user or non-wake dot visible %j", (opts) => {
    const r = rig(opts);
    expect(isShownMessage(r.reply("·"))).toBe(true);
    expect(turnAddedMessage(r.messages, 0)).toBe(true);
    expect(r.notification()).not.toBeNull();
  });

  it.each([{ paneNoteWake: true }, { keepGoingWake: true }, { automationSource: "schedule" as const }])("preserves real replies and existing notification policy %j", (opts) => {
    const r = rig(opts);
    expect(isShownMessage(r.reply("The checks passed."))).toBe(true);
    expect(turnAddedMessage(r.messages, 0)).toBe(true);
    expect(Boolean(r.notification())).toBe(!("paneNoteWake" in opts));
  });

  it("preserves tools, worker notes and errors", () => {
    const r = rig({ paneNoteWake: true });
    r.reply("·");
    r.messages.push({ id: "tool", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } });
    expect(isShownMessage(r.messages[1])).toBe(true);
    expect(turnAddedMessage(r.messages, 0)).toBe(false);
    r.messages.push({ id: "error", at: 2, role: "bot", kind: "activity", tool: { name: "error: failed", ok: false } });
    expect(turnAddedMessage(r.messages, 0)).toBe(true);
  });

  it("keeps the hidden dot in model replay without the engine-summary prefix", async () => {
    const r = rig({ paneNoteWake: true });
    const message = r.reply("·");
    const context = (messages: Message[]) => prepareModelContext({ messages, contextWindow: 128_000, taskRecordText: "" });
    const hidden = await context([message]);
    expect(hidden).toEqual(await context([{ ...message, hidden: undefined }]));
    expect(hidden.status === "ready" && hidden.transcript).toEqual([{ role: "assistant", text: "·" }]);
  });

  it("keeps a dot visible after a folded or steered user message", () => {
    const folded = rig({ paneNoteWake: true }, ["User joined"]);
    expect(isShownMessage(folded.reply("·"))).toBe(true);
    const steered = rig({ keepGoingWake: true });
    steered.quietWakeTurns.delete("thread");
    expect(isShownMessage(steered.reply("·"))).toBe(true);
    expect(steered.notification()).not.toBeNull();
  });

  it("classifies a room routine without hiding a user's room turn or a different member", () => {
    const r = rig();
    const run = { botId: "bot", sourceThreadId: "thread", status: "running" as const };
    r.quietWakeTurns.startRoom("thread", "bot", true, [run]);
    expect(isShownMessage(r.reply("·"))).toBe(false);
    r.quietWakeTurns.startRoom("thread", "bot", false, [run]);
    expect(isShownMessage(r.reply("·"))).toBe(true);
    r.quietWakeTurns.startRoom("thread", "other", true, [run]);
    expect(isShownMessage(r.reply("·"))).toBe(true);
    r.quietWakeTurns.startRoom("thread", "bot", true, [{ ...run, status: "completed" }]);
    expect(isShownMessage(r.reply("·"))).toBe(true);
  });

  it.each(["", "·", " \n· "])("does not mark a quiet routine completion card unread for %j", (output) => {
    const r = rig({ automationSource: "schedule" });
    let unread = false;
    execute(routineUnread.getText(parsed), {
      statusChanged: true, run: { status: "completed", output }, sourceThreadId: "thread",
      quietWakeTurns: r.quietWakeTurns, source: { bot: { id: "bot" } },
      store: { patchBot: () => { unread = true; } },
    });
    expect(unread).toBe(false);
    for (const status of ["waiting", "failed", "missed"] as const) {
      expect(r.quietWakeTurns.routineUnread("thread", status, output)).toBe(true);
    }
    expect(r.quietWakeTurns.routineUnread("thread", "completed", "The checks passed.")).toBe(true);
    expect(r.quietWakeTurns.routineUnread("user-thread", "completed", output)).toBe(true);
  });

  it("holds a possible dot stream, then releases the whole prefix for real text", () => {
    const r = rig({ paneNoteWake: true });
    expect(r.quietWakeTurns.broadcast(delta(" \n"))).toBeNull();
    expect(r.quietWakeTurns.broadcast(delta("·"))).toBeNull();
    expect(r.quietWakeTurns.broadcast(delta(" "))).toBeNull();
    expect(r.quietWakeTurns.broadcast(delta("Checked"))).toMatchObject({ delta: " \n· Checked" });
    expect(r.quietWakeTurns.broadcast(delta(" it"))).toMatchObject({ delta: " it" });
    r.quietWakeTurns.broadcast({ ...base, type: "item.completed", itemType: "assistant_text", text: "· Checked it" });
    expect(r.quietWakeTurns.broadcast(delta("·"))).toBeNull();
  });

  it("leaves reasoning, user streams and other threads alone, and resets on the next dispatch", () => {
    const r = rig({ paneNoteWake: true });
    const reasoning: RuntimeEvent = { ...delta("thinking"), streamKind: "reasoning_text" };
    expect(r.quietWakeTurns.broadcast(reasoning)).toBe(reasoning);
    expect(r.quietWakeTurns.broadcast({ ...delta("·"), threadId: "other" })).toMatchObject({ delta: "·" });
    r.quietWakeTurns.start("thread", undefined, []);
    expect(r.quietWakeTurns.broadcast(delta("·"))).toMatchObject({ delta: "·" });
    expect(isShownMessage(r.reply("·"))).toBe(true);
  });

  it("wires wake classification, late user joins and stream filtering at the source", () => {
    expect(source).toContain("quietWakeTurns.start(threadId, opts, folded)");
    expect(source).toContain("quietWakeTurns.broadcast(event)");
    expect(source).toContain("quietWakeTurns.startRoom(threadId, bot.id, Boolean(cardContinuation), routines?.listRuns() ?? [])");
    const late = source.slice(source.indexOf("const queued = foldQueuedSends("));
    expect(late.slice(0, 650)).toContain("quietWakeTurns.delete(threadId)");
    const route = readFileSync(new URL("./bot-chat-routes.ts", import.meta.url), "utf8");
    expect(route.slice(route.indexOf("takeover.accepted();"), route.indexOf("takeover.accepted();") + 300)).toContain("quietWakeTurns.delete(threadId)");
  });
});
