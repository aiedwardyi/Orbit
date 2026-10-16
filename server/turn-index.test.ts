import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { turnWords } from "../shared/turn-index.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { turnIndex } from "./turn-index.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const user = (text: string, extra: Partial<Message> = {}) => ({ role: "user" as const, kind: "text" as const, text, ...extra });

describe("turn index", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("counts typed and bot-sent messages on the active path and nothing else", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const hello = store.appendMessage(threadId, { role: "bot", kind: "text", text: "Hi, I'm Scout." });
    const asked = store.appendMessage(threadId, user("Fix the build"));
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } });
    store.appendMessage(threadId, { role: "bot", kind: "note", text: "[pane 1a2b3c4d] [JOB] from A (a): DONE JOB branch=x sha=y dirty=no" });
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "error: Usage limit reached" } });
    store.appendMessage(threadId, { role: "bot", kind: "routine.run", text: "Daily summary ran" });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "Fixed." });
    const peer = store.appendMessage(threadId, user("Please review the fix", { from: { botId: "b", name: "Reviewer", color: "blue" } }));
    const old = store.appendMessage(threadId, user("Ship it"));
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "Shipping." });
    const edited = store.branchMessage(threadId, old.id, "Ship it tomorrow")!;

    const index = turnIndex(store.activePath(threadId));
    expect(index.ids).toEqual([asked.id, peer.id, edited.id]);
    expect(index.words).toEqual(["Fix the build", "Please review the fix", "Ship it tomorrow"]);
    expect(index.first).toBe(hello.id);
  });

  it("sends times as whole seconds, then the gap since the turn before", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const at = [Date.UTC(2026, 8, 7, 23, 59, 58, 900), Date.UTC(2026, 8, 8, 0, 0, 3, 100), Date.UTC(2026, 9, 16, 9, 30)];
    for (const [i, time] of at.entries()) {
      store.appendMessage(threadId, user(`turn ${i}`, { at: time }));
      store.appendMessage(threadId, { role: "bot", kind: "text", text: "ok", at: time + 500 });
    }

    const index = turnIndex(store.activePath(threadId));
    expect(index.at).toEqual([Math.floor(at[0] / 1000), 5, 3_317_397]);
    let seconds = 0;
    expect(index.at.map((gap) => (seconds += gap) * 1000)).toEqual(at.map((time) => Math.floor(time / 1000) * 1000));
  });

  it("skips summarized bot notes when it picks the first message", () => {
    const path: Message[] = [
      { id: "s", at: 1, role: "bot", kind: "text", text: "summary", summarized: true },
      { id: "c", at: 2, role: "bot", kind: "options", card: { title: "?", subtitle: "", options: [] } },
      { id: "u", at: 3, role: "user", kind: "text", text: "hello" },
    ];
    expect(turnIndex(path)).toMatchObject({ ids: ["u"], first: "u" });
    expect(turnIndex([])).toEqual({ ids: [], at: [], words: [], first: null });
  });
});

describe("turn words", () => {
  it("keeps a short line whole and folds its whitespace", () => {
    expect(turnWords("  Run the  tests\n\nand tell me ")).toBe("Run the tests and tell me");
  });

  it("cuts a long line at a word, without trailing punctuation", () => {
    const words = turnWords("Profile scrolling in a long thread, then find the slow frame and fix it");
    expect(words).toBe("Profile scrolling in a long thread, then…");
  });

  it("counts Hangul twice and still cuts at a word", () => {
    const text = "폰에서 키보드가 열릴 때 컴포저가 튀는 이유 좀 확인해줘";
    const words = turnWords(text);
    expect(words).toBe("폰에서 키보드가 열릴 때 컴포저가 튀는…");
    expect(text.startsWith(words.slice(0, -1))).toBe(true);
    expect(text.charAt(words.length - 1)).toBe(" ");
  });

  it("drops a word that would overflow, and hard-cuts only a first word longer than a row", () => {
    expect(turnWords(`see ${"x".repeat(60)}`)).toBe("see…");
    expect(turnWords("x".repeat(60))).toBe(`${"x".repeat(40)}…`);
  });

  it("shows attachments the way the bubble does", () => {
    const text = 'Look at this\n<attached-image path="C:\\a\\shot.png" />\n<attached-file path="C:\\a\\notes.txt" name="Q&amp;A.txt" size="12" />\n<pasted-text index="1">\nlogs here\n</pasted-text>';
    expect(turnWords(text)).toBe("Look at this Q&A.txt logs here");
  });
});
