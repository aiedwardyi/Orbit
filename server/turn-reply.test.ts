import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ownTurnReply, turnSummaries } from "./turn-reply.ts";

function rig(staleTurns: string[]) {
  const bus = new EventBus(() => {});
  const stale = (_threadId: string, turnId: string | undefined) => Boolean(turnId && staleTurns.includes(turnId));
  const shown: string[] = [];
  bus.subscribe((e) => {
    if (stale(e.threadId, e.turnId)) return;
    if (e.type === "item.completed" && e.itemType === "assistant_text") shown.push(e.text);
  });
  const reply = ownTurnReply(stale);
  let text = "";
  let completed = false;
  bus.subscribe((e) => {
    const step = reply.fold(e);
    if (step === "completed") completed = true;
    else if (step) text += (text ? "\n" : "") + step.text;
  });
  const event = (turnId: string, patch: Record<string, unknown>) => bus.publish({
    provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: "t1", turnId, ...patch,
  } as RuntimeEvent);
  return { reply, event, shown, text: () => text, completed: () => completed };
}

describe("ownTurnReply", () => {
  it("drops a stopped turn's late text and completion", () => {
    const r = rig(["stopped"]);
    r.event("current", { type: "turn.started" });
    r.event("stopped", { type: "item.completed", itemType: "assistant_text", text: "obsolete answer" });
    r.event("stopped", { type: "turn.completed", ok: false });
    expect(r.completed()).toBe(false);
    r.event("current", { type: "item.completed", itemType: "assistant_text", text: "current answer" });
    r.event("current", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("current answer");
    expect(r.completed()).toBe(true);
    expect(r.shown).toEqual(["current answer"]);
  });

  it("ignores another live turn once it owns one", () => {
    const r = rig([]);
    r.reply.claim("mine");
    r.event("other", { type: "item.completed", itemType: "assistant_text", text: "not mine" });
    r.event("other", { type: "turn.completed", ok: true });
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "mine" });
    expect(r.completed()).toBe(false);
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("mine");
    expect(r.completed()).toBe(true);
  });

  it("marks an engine summary in the collected reply", () => {
    const r = rig([]);
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "Checking the logs.", summarized: true });
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "All clear." });
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("[Engine summary of a mid-turn note, not shown to the user; the exact words were not kept] Checking the logs.\nAll clear.");
  });

  it("adopts its turn from the first fresh text", () => {
    const r = rig([]);
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "mine" });
    r.event("other", { type: "item.completed", itemType: "assistant_text", text: "not mine" });
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("mine");
    expect(r.completed()).toBe(true);
  });
});

describe("turnSummaries", () => {
  it("shows a turn's summaries when it wrote no other text", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "turn-1", "s1", true);
    summaries.note("t1", "turn-1", "s2", true);
    expect(summaries.settle("t1", "turn-1")).toEqual(["s1", "s2"]);
    expect(summaries.settle("t1", "turn-1")).toEqual([]);
  });

  it("keeps summaries hidden once the turn wrote plain text", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "turn-1", "s1", true);
    summaries.note("t1", "turn-1", "r1", false);
    summaries.note("t1", "turn-1", "s2", true);
    expect(summaries.settle("t1", "turn-1")).toEqual([]);
  });

  it("never lets an older turn's completion settle the next turn", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "old", "r0", false);
    summaries.note("t1", "new", "s1", true);
    expect(summaries.settle("t1", "old")).toEqual([]);
    expect(summaries.settle("t1", "new")).toEqual(["s1"]);
  });

  it("keeps threads apart", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "a", "s1", true);
    summaries.note("t2", "b", "r1", false);
    expect(summaries.settle("t2", "b")).toEqual([]);
    expect(summaries.settle("t1", "a")).toEqual(["s1"]);
  });
});
