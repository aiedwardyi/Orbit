import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { onPeerTakeover, peerAnswer, takeOverPeerTurn } from "./peer-takeover.ts";

function ask(threadId: string) {
  const answers: string[] = [];
  const answer = peerAnswer(threadId, "Wink", () => "Edward", (text) => answers.push(text));
  return { answer, answers };
}

describe("ask_bot takeover", () => {
  it("answers the asker with only the text from before the user's message", () => {
    const { answer, answers } = ask("t-ask-1");
    answer.add("The build is green.");
    expect(takeOverPeerTurn("t-ask-1")).toBe(true);
    answer.add("Edward, 1.0.157 is out.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["The build is green."]);
  });

  it("says the bot switched when the user cut in before any text", () => {
    const { answer, answers } = ask("t-ask-2");
    takeOverPeerTurn("t-ask-2");
    answer.add("Edward, 1.0.157 is out.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["Wink switched to Edward's message before answering. Ask again later."]);
  });

  it("keeps the whole reply when nobody cuts in", () => {
    const { answer, answers } = ask("t-ask-3");
    answer.add("First.");
    answer.add("Second.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["First.\nSecond."]);
    expect(takeOverPeerTurn("t-ask-3")).toBe(false);
  });
});

describe("peer turn registry", () => {
  it("takes a watched turn over once and ignores unwatched threads", () => {
    let calls = 0;
    onPeerTakeover("t-reg-1", () => calls++);
    expect(takeOverPeerTurn("t-other")).toBe(false);
    expect(takeOverPeerTurn("t-reg-1")).toBe(true);
    expect(takeOverPeerTurn("t-reg-1")).toBe(false);
    expect(calls).toBe(1);
  });

  it("forgets a turn once it ends", () => {
    let calls = 0;
    const end = onPeerTakeover("t-reg-2", () => calls++);
    end();
    expect(takeOverPeerTurn("t-reg-2")).toBe(false);
    expect(calls).toBe(0);
  });

  it("keeps a delegated turn's watch when an ask on the same bot fails to start", () => {
    let calls = 0;
    onPeerTakeover("t-reg-3", () => calls++);
    const { answer, answers } = ask("t-reg-3");
    answer.end("(couldn't start that bot: the bot is already working)");
    expect(takeOverPeerTurn("t-reg-3")).toBe(true);
    expect(calls).toBe(1);
    expect(answers).toEqual(["(couldn't start that bot: the bot is already working)"]);
  });

  it("takes over every turn watching the thread", () => {
    let calls = 0;
    onPeerTakeover("t-reg-4", () => calls++);
    const { answer, answers } = ask("t-reg-4");
    expect(takeOverPeerTurn("t-reg-4")).toBe(true);
    answer.end("(the bot finished without a text reply)");
    expect(calls).toBe(1);
    expect(answers).toEqual(["Wink switched to Edward's message before answering. Ask again later."]);
    expect(takeOverPeerTurn("t-reg-4")).toBe(false);
  });

  it("a control-plane steer doesn't take over", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const calls = index.match(/takeOverPeerTurn\(/g) ?? [];
    // the send route's steer and the two folds of queued user sends, nothing else
    const userJoins = index.match(/resumePaneWakes\((?:bot|current)\.id\);\r?\n\s*takeOverPeerTurn\(threadId\);/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(userJoins).toHaveLength(3);
    expect(index).toMatch(/\.steer\(threadId, composeUserTurnPrompt\(text,/);
    const paneWake = index.slice(index.indexOf("const paneWake = new PaneWakeScheduler("));
    expect(paneWake.slice(0, paneWake.indexOf("\n});"))).not.toContain("takeOverPeerTurn");
    for (const driver of ["./drivers/claude.ts", "./drivers/codex.ts", "./drivers/acp/core.ts"]) {
      expect(readFileSync(new URL(driver, import.meta.url), "utf8")).not.toContain("takeOverPeerTurn");
    }
  });
});
