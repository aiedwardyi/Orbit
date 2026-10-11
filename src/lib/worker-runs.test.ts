import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { byUrgency, parseWorkerLabel, shownState, workerProvider, workerRuns } from "./worker-runs";

const BOT = "61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const PANE = "5d09c0d0-2844-43b0-982e-88305df70570";
const OTHER = "0f3c9a1e-1111-4222-8333-944455556666";

const launch = (id: string, at: number, label: string, session = PANE): Message => ({
  id, at, role: "bot", kind: "launch",
  text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${session}`,
});
const note = (id: string, at: number, text: string, label: string | null = "REL-CHAIN-166 | script", session = PANE): Message => ({
  id, at, role: "bot", kind: "note",
  text: `[pane ${session.slice(0, 8)}]${label ? ` [${label}]` : ""} from Wink (${BOT}): ${text}`,
});
const report = (status: string, nick: string, body = "") => `${status} ${nick} branch=x sha=y dirty=no${body ? `\n${body}` : ""}`;
const STALLED = "STALLED: no screen change for 2 min and no report. terminal_read its pane.";

describe("workerRuns", () => {
  it("folds a launch and its report into one run", () => {
    const [run, ...rest] = workerRuns([
      launch("l1", 1, "WORKER-ROWS | Opus 5.5 | high"),
      note("n1", 2, report("DONE", "WORKER-ROWS", "All green."), "WORKER-ROWS | Opus 5.5 | high"),
    ]);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ nick: "WORKER-ROWS", model: "Opus 5.5", provider: "claudeAgent", state: "done", sessionId: PANE, pane8: "5d09c0d0", folder: "C:\\repo", messageIds: ["l1", "n1"] });
    expect(run!.notes.map((n) => n.note.body)).toEqual(["All green."]);
  });

  it("keeps a launch with no note working", () => {
    expect(workerRuns([launch("l1", 1, "A | Sonnet 5.5 | low")])[0]!.state).toBe("working");
  });

  it("splits two jobs from one script pane by nickname", () => {
    const runs = workerRuns([
      launch("l1", 1, "REL-CHAIN-166 | script"),
      note("n1", 2, report("DONE", "REL-CHAIN-166")),
      note("n2", 3, report("FAIL", "POST-166", "upload broke")),
    ]);
    expect(runs.map((r) => [r.nick, r.state, r.messageIds])).toEqual([
      ["REL-CHAIN-166", "done", ["l1", "n1"]],
      ["POST-166", "failed", ["n2"]],
    ]);
    expect(runs.map((r) => r.provider)).toEqual(["script", "script"]);
  });

  it("keeps a relaunched pane and nickname as one run, working again", () => {
    const runs = workerRuns([
      launch("l1", 1, "A | Opus 5.5 | high"),
      note("n1", 2, report("DONE", "A"), "A | Opus 5.5 | high"),
      launch("l2", 3, "A | Opus 5.5 | high"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "working", messageIds: ["l1", "l2", "n1"] });
  });

  it("lets DONE replace a stalled note", () => {
    const runs = workerRuns([
      launch("l1", 1, "A | GPT-6 Astra | high"),
      note("n1", 2, STALLED, "A | GPT-6 Astra | high"),
      note("n2", 3, report("DONE", "A"), "A | GPT-6 Astra | high"),
    ]);
    expect(runs[0]).toMatchObject({ state: "done", provider: "codex" });
  });

  it("reads a stalled, waiting or blocked newest note as waiting", () => {
    const label = "A | Gemini 3.8 | high";
    for (const text of [STALLED, "WAITING: this worker is stuck on an on-screen prompt (permission check).", report("BLOCKED", "A", "Which skin?")]) {
      expect(workerRuns([launch("l1", 1, label), note("n1", 2, text, label)])[0]!.state).toBe("waiting");
    }
  });

  it("orders notes by time, not transcript position", () => {
    const label = "A | Grok 4.7 | high";
    const run = workerRuns([
      note("n2", 3, report("DONE", "A"), label),
      launch("l1", 1, label),
      note("n1", 2, STALLED, label),
    ])[0]!;
    expect(run.state).toBe("done");
    expect(run.messageIds[0]).toBe("l1");
    expect(run.notes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("makes a run from a note whose launch is not loaded", () => {
    const run = workerRuns([note("n1", 5, report("BLOCKED", "OLD-JOB"), "OLD-JOB | Muse 1.3 | high")])[0]!;
    expect(run).toMatchObject({ nick: "OLD-JOB", model: "Muse 1.3", provider: "museAgent", state: "waiting", at: 5, sessionId: null, messageIds: ["n1"] });
  });

  it("files a nickless note under the newest run in its pane", () => {
    const runs = workerRuns([
      launch("l1", 1, "REL-CHAIN-166 | script"),
      note("n1", 2, report("DONE", "REL-CHAIN-166")),
      note("n2", 3, report("BLOCKED", "POST-166")),
      note("n3", 4, STALLED),
    ]);
    expect(runs.map((r) => [r.nick, r.state])).toEqual([["REL-CHAIN-166", "done"], ["POST-166", "waiting"]]);
    expect(runs[1]!.messageIds).toEqual(["n2", "n3"]);
  });

  it("survives a malformed label", () => {
    const runs = workerRuns([
      launch("l1", 1, "pane", OTHER),
      launch("l2", 2, " | | ", "77777777-0000"),
      { id: "l3", at: 3, role: "bot", kind: "launch", text: "Launched X" },
      note("n1", 4, "halfway", null),
    ]);
    expect(runs.map((r) => [r.nick, r.model, r.provider, r.state])).toEqual([
      ["pane", null, null, "working"],
      ["77777777", null, null, "working"],
      ["X", null, null, "working"],
      ["5d09c0d0", null, null, "working"],
    ]);
  });

  it("ignores notes without a pane and other messages", () => {
    expect(workerRuns([
      { id: "t", at: 1, role: "bot", kind: "text", text: "hi" },
      { id: "n", at: 2, role: "bot", kind: "note", text: "Synced from Work PC" },
    ])).toEqual([]);
  });

  it("keeps runs from two room members apart", () => {
    const from = (botId: string) => ({ botId, name: botId, color: "blue" as const });
    const runs = workerRuns([
      { ...launch("l1", 1, "A | Opus 5.5 | high"), from: from("b1") },
      { ...launch("l2", 2, "A | Opus 5.5 | high"), from: from("b2") },
      { ...note("n1", 3, report("DONE", "A"), "A | Opus 5.5 | high"), from: from("b2") },
    ]);
    expect(runs.map((r) => [r.botId, r.state])).toEqual([["b1", "working"], ["b2", "done"]]);
  });
});

describe("parseWorkerLabel", () => {
  it("splits nickname and model", () => {
    expect(parseWorkerLabel("NICK | Fable 5.1 | high")).toEqual({ nick: "NICK", model: "Fable 5.1" });
    expect(parseWorkerLabel("NICK")).toEqual({ nick: "NICK", model: null });
    expect(parseWorkerLabel(null)).toEqual({ nick: null, model: null });
  });
});

describe("workerProvider", () => {
  it.each([
    ["Sonnet 5.5", "claudeAgent"], ["Opus 5.5", "claudeAgent"], ["Fable 5.1", "claudeAgent"],
    ["GPT-6 Astra", "codex"], ["GPT-6.1 Sol", "codex"], ["Muse 1.3", "museAgent"],
    ["Grok 4.7", "grokAgent"], ["Gemini 3.8", "geminiAgent"], ["script", "script"], ["Mystery 2", null],
  ])("maps %s to %s", (model, provider) => {
    expect(workerProvider(model)).toBe(provider);
  });
});

describe("shownState", () => {
  const [run] = workerRuns([launch("l1", 1, "A | Opus 5.5 | high")]);
  it("ends a working run whose pane closed, and keeps it while unknown", () => {
    expect(shownState(run!, null)).toBe("working");
    expect(shownState(run!, new Set([PANE]))).toBe("working");
    expect(shownState(run!, new Set())).toBe("ended");
  });

  it("matches a note-only run by pane prefix and never ends a final report", () => {
    const [orphan] = workerRuns([note("n1", 1, STALLED)]);
    expect(shownState(orphan!, new Set([PANE]))).toBe("waiting");
    expect(shownState(orphan!, new Set())).toBe("ended");
    const [done] = workerRuns([note("n1", 1, report("DONE", "A"))]);
    expect(shownState(done!, new Set())).toBe("done");
  });
});

describe("byUrgency", () => {
  it("puts waiting, failed, working, done, then launch order", () => {
    const runs = workerRuns([
      launch("a", 1, "A | Opus 5.5 | high", "aaaaaaaa"),
      launch("b", 2, "B | Opus 5.5 | high", "bbbbbbbb"),
      note("bn", 3, report("DONE", "B"), "B | Opus 5.5 | high", "bbbbbbbb"),
      launch("c", 4, "C | Opus 5.5 | high", "cccccccc"),
      note("cn", 5, report("FAIL", "C"), "C | Opus 5.5 | high", "cccccccc"),
      launch("d", 6, "D | Opus 5.5 | high", "dddddddd"),
      note("dn", 7, STALLED, "D | Opus 5.5 | high", "dddddddd"),
      launch("e", 8, "E | Opus 5.5 | high", "eeeeeeee"),
    ]);
    const sorted = runs.map((run) => ({ run, state: shownState(run, null) })).sort(byUrgency);
    expect(sorted.map((r) => r.run.nick)).toEqual(["D", "C", "A", "E", "B"]);
  });
});
