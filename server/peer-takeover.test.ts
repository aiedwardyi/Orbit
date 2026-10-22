import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hasPeerWatch, onPeerTakeover, peerAnswer, peerInputJoined, steerTakeover, takeOverPeerTurn, takePeerReplyStamp } from "./peer-takeover.ts";
import type { Message } from "./store.ts";

function ask(threadId: string) {
  const answers: string[] = [];
  const answer = peerAnswer(threadId, "Wink", () => "Edward", (text) => answers.push(text));
  return { answer, answers };
}

describe("ask_bot takeover", () => {
  it.each(["A real answer", "(timed out waiting for the bot to reply)"])("reports a real text reply without inspecting its wording: %s", (text) => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-signal", "Wink", () => "Edward", (out, replied) => answers.push({ text: out, replied }));
    answer.add(text);
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text, replied: true }]);
  });

  it.each([
    ["timeout", "(timed out waiting for the bot to reply)"],
    ["no text", "(the bot finished without a text reply)"],
    ["start failure", "(couldn't start that bot: unavailable)"],
  ])("does not report a reply after %s", (outcome, fallback) => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-no-reply", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.end(fallback, outcome === "no text");
    expect(answers).toEqual([{ text: fallback, replied: false }]);
  });

  it("does not report a timed-out partial answer as a reply", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-partial", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Partial answer");
    answer.end("(timed out waiting for the bot to reply)", false);
    expect(answers).toEqual([{ text: "Partial answer", replied: false }]);
  });

  it("does not report a user takeover before any text as a reply", () => {
    const answers: boolean[] = [];
    peerAnswer("t-signal-takeover", "Wink", () => "Edward", (_text, replied) => answers.push(replied));
    takeOverPeerTurn("t-signal-takeover");
    expect(answers).toEqual([false]);
  });

  it("reports a user takeover after some text as a reply", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-partial-takeover", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Partial");
    takeOverPeerTurn("t-partial-takeover");
    expect(answers).toEqual([{ text: "Partial", replied: true }]);
  });

  it("answers the asker with only the text from before the user's message", () => {
    const { answer, answers } = ask("t-ask-1");
    answer.add("The build is green.");
    expect(takeOverPeerTurn("t-ask-1")).toBe(true);
    answer.add("Edward, 1.0.157 is out.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["The build is green."]);
  });

  it("keeps the full answer when the user's message was read after the reply", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-ask-after", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("The build is green.");
    expect(takeOverPeerTurn("t-ask-after", true)).toBe(true);
    answer.add("Edward, 1.0.157 is out.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "The build is green.", replied: true }]);
  });

  it("says the bot switched when the user cut in before any text", () => {
    const { answer, answers } = ask("t-ask-2");
    takeOverPeerTurn("t-ask-2");
    answer.add("Edward, 1.0.157 is out.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["Wink switched to Edward's message before answering. Ask again later."]);
  });

  it("answers the asker with only the text from before a pane note joined", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-ask-note", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Got the note.");
    peerInputJoined("t-ask-note");
    answer.add("The eval questions are ready.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Got the note.", replied: true }]);
  });

  it("does not report a reply when a pane note joined before any text", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-ask-note-empty", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    peerInputJoined("t-ask-note-empty");
    answer.add("The eval questions are ready.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Wink took in a worker's note before answering. Ask again later.", replied: false }]);
    expect(hasPeerWatch("t-ask-note-empty")).toBe(false);
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

  it("tells every watch a pane note joined without taking the turn over", () => {
    let joined = 0;
    let taken = 0;
    const end = onPeerTakeover("t-reg-note", () => taken++, () => joined++);
    onPeerTakeover("t-reg-note", () => taken++);
    peerInputJoined("t-reg-note");
    peerInputJoined("t-other");
    expect(joined).toBe(1);
    expect(hasPeerWatch("t-reg-note")).toBe(true);
    expect(takeOverPeerTurn("t-reg-note")).toBe(true);
    expect(taken).toBe(2);
    end();
  });

  it("hands the read state to every watch", () => {
    const seen: boolean[] = [];
    onPeerTakeover("t-reg-after", (afterReply) => seen.push(afterReply));
    takeOverPeerTurn("t-reg-after", true);
    expect(seen).toEqual([true]);
  });

  it("reports a live peer watch until it ends or is taken over", () => {
    expect(hasPeerWatch("t-watch-1")).toBe(false);
    const endAsk = onPeerTakeover("t-watch-1", () => {});
    expect(hasPeerWatch("t-watch-1")).toBe(true);
    endAsk();
    expect(hasPeerWatch("t-watch-1")).toBe(false);
    onPeerTakeover("t-watch-2", () => {});
    expect(hasPeerWatch("t-watch-2")).toBe(true);
    takeOverPeerTurn("t-watch-2");
    expect(hasPeerWatch("t-watch-2")).toBe(false);
  });

  it("a control-plane steer doesn't take over", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const calls = index.match(/takeOverPeerTurn\(/g) ?? [];
    // the two folds of queued user sends; the send route's steer defers to the read
    const userJoins = index.match(/resumePaneWakes\((?:bot|current)\.id\);\r?\n\s*takeOverPeerTurn\(threadId\);/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(userJoins).toHaveLength(2);
    expect(index).toMatch(/const prompt = consumable \? composeUserTurnPrompt\(text, turnOpts\)/);
    expect(index).toMatch(/\.steer\(threadId, prompt, \(taken, afterReply\) =>/);
    expect(index).toMatch(/peerTurn: hasPeerWatch\(threadId\)/);
    expect(index).toMatch(/takeover\.accepted\(\);/);
    const paneWake = index.slice(index.indexOf("const paneWake = new PaneWakeScheduler("));
    expect(paneWake.slice(0, paneWake.indexOf("\n});"))).not.toContain("takeOverPeerTurn");
    for (const driver of ["./drivers/claude.ts", "./drivers/codex.ts", "./drivers/acp/core.ts"]) {
      expect(readFileSync(new URL(driver, import.meta.url), "utf8")).not.toContain("takeOverPeerTurn");
    }
  });
});

describe("steered takeover", () => {
  it("takes over at the read once the route accepts it", () => {
    const seen: boolean[] = [];
    onPeerTakeover("t-steer-1", (afterReply) => seen.push(afterReply));
    const takeover = steerTakeover("t-steer-1", true);
    takeover.accepted();
    expect(seen).toEqual([]);
    takeover.consumed(true, true);
    expect(seen).toEqual([true]);
    takeover.consumed(true, true);
    takeover.accepted();
    expect(seen).toEqual([true]);
  });

  it("takes over at accept when the signal arrived first", () => {
    const seen: boolean[] = [];
    onPeerTakeover("t-steer-2", (afterReply) => seen.push(afterReply));
    const takeover = steerTakeover("t-steer-2", true);
    takeover.consumed(true, true);
    expect(seen).toEqual([]);
    takeover.accepted();
    expect(seen).toEqual([true]);
  });

  it("takes over at once when the read reports the message never landed", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    peerAnswer("t-steer-false", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    const takeover = steerTakeover("t-steer-false", true);
    takeover.accepted();
    takeover.consumed(false);
    takeover.consumed(false);
    takeover.accepted();
    expect(answers).toEqual([{ text: "Wink switched to Edward's message before answering. Ask again later.", replied: false }]);
  });

  it("never takes over a steer the route rejected", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-steer-reject", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    const takeover = steerTakeover("t-steer-reject", true);
    takeover.consumed(true, true);
    answer.add("Partial.");
    answer.add("Rest.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Partial.\nRest.", replied: true }]);
  });

  it("takes over at accept without a read signal", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-steer-nosignal", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Partial.");
    const takeover = steerTakeover("t-steer-nosignal", false);
    takeover.accepted();
    answer.add("Rest.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Partial.", replied: true }]);
  });
});

describe("peer reply stamp", () => {
  const comm: NonNullable<Message["comm"]> = { groupId: "pair", withBotId: "atlas", withName: "Atlas", withColor: "pink" };
  const pending = () => new Map<string, NonNullable<Message["comm"]>>([["t-stamp", { ...comm }]]);

  it("stamps the first shown text while the watch is live, copied as is", () => {
    const end = onPeerTakeover("t-stamp", () => {});
    try {
      const stamped = takePeerReplyStamp(pending(), "t-stamp", { text: "Two bullets were reworded." });
      expect(stamped).toEqual(comm);
      expect(stamped).not.toHaveProperty("peer");
    } finally {
      end();
    }
  });

  it.each([
    ["summarized", { text: "An engine summary.", summarized: true }],
    ["blank", { text: "  \n " }],
    ["missing", {}],
  ])("skips a %s row", (_kind, message) => {
    const end = onPeerTakeover("t-stamp", () => {});
    try {
      expect(takePeerReplyStamp(pending(), "t-stamp", message)).toBeUndefined();
    } finally {
      end();
    }
  });

  it("skips an ordinary turn with no pending comm", () => {
    const end = onPeerTakeover("t-stamp", () => {});
    try {
      expect(takePeerReplyStamp(new Map(), "t-stamp", { text: "Hello." })).toBeUndefined();
    } finally {
      end();
    }
  });

  it("stamps once per turn", () => {
    const end = onPeerTakeover("t-stamp", () => {});
    try {
      const live = pending();
      expect(takePeerReplyStamp(live, "t-stamp", { text: "First." })).toEqual(comm);
      expect(takePeerReplyStamp(live, "t-stamp", { text: "Second." })).toBeUndefined();
    } finally {
      end();
    }
  });

  it("stays bare once the user takes the turn over", () => {
    const end = onPeerTakeover("t-stamp", () => {});
    takeOverPeerTurn("t-stamp");
    end();
    expect(takePeerReplyStamp(pending(), "t-stamp", { text: "Late text." })).toBeUndefined();
  });

  it("index.ts keeps the pending comm per thread and clears it on settle and on stamp", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/peerReplyComm\.set\(threadId, opts\??\.peerComm\)/);
    expect(index).toMatch(/peerReplyComm\.delete\(event\.threadId\)/);
    expect(index).toMatch(/takePeerReplyStamp\(peerReplyComm, event\.threadId/);
  });
});
