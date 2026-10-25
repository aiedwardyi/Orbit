import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { byUrgency, latestPaneRun, listedRuns, listedSessionId, parseWorkerLabel, shownState, workerAnchors, workerProvider, workerRuns } from "./worker-runs";

const BOT = "61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const PANE = "5d09c0d0-2844-43b0-982e-88305df70570";
const OTHER = "0f3c9a1e-1111-4222-8333-944455556666";

const launch = (id: string, at: number, label: string, session = PANE): Message => ({
  id, at, role: "bot", kind: "launch",
  text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${session}`,
});
const resume = (id: string, at: number, label: string, session = PANE): Message => ({
  id, at, role: "bot", kind: "launch",
  text: `Resumed ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${session}`,
});
const note = (id: string, at: number, text: string, label: string | null = "REL-CHAIN-166 | script", session = PANE): Message => ({
  id, at, role: "bot", kind: "note",
  text: `[pane ${session.slice(0, 8)}]${label ? ` [${label}]` : ""} from Wink (${BOT}): ${text}`,
});
const report = (status: string, nick: string, body = "") => `${status} ${nick} branch=x sha=y dirty=no${body ? `\n${body}` : ""}`;
const STALLED = "STALLED: no screen change for 2 min and no report. terminal_read its pane.";
const LIMIT = "LIMIT: Codex hit its usage limit (resets 5:49 AM). Its work so far stays in C:\\repo. Send \"continue\" after the reset, or move the job to another engine.";

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

  it.each(["DONE", "FAIL"])("keeps %s when the session's launch note arrives after its report", (status) => {
    const run = workerRuns([
      note("n1", 1, report(status, "A", "fast script report"), "A | script"),
      launch("l1", 2, "A | script"),
    ])[0]!;
    expect(run.state).toBe(status === "DONE" ? "done" : "failed");
    expect(run.messageIds).toEqual(["l1", "n1"]);
    expect(run.notes[0]!.note.body).toBe("fast script report");
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

  it("starts a new working run when a nickname relaunches in a new pane", () => {
    const runs = workerRuns([
      launch("l1", 1, "A | Opus 5.5 | high"),
      note("n1", 2, report("DONE", "A"), "A | Opus 5.5 | high"),
      launch("l2", 3, "A | Opus 5.5 | high", OTHER),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "done", messageIds: ["l1", "n1"] });
    expect(runs[1]).toMatchObject({ state: "working", sessionId: OTHER, messageIds: ["l2"] });
  });

  it("gives a restart note its own Wink row instead of its first pane's", () => {
    const restarted = `RESTARTED: Wink restarted, so these panes you spawned closed mid-run:\n- A | Opus 5.5 | high [pane ${PANE.slice(0, 8)}] in C:\\repo, spawned 2026-10-14T00:12:00.000Z\nEdits in their folders are still there. Spawn a FRESH worker to continue, or tell the user.`;
    const runs = workerRuns([launch("l1", 1, "A | Opus 5.5 | high"), note("n1", 2, restarted, null)]);
    expect(runs.map((run) => [run.nick, run.messageIds])).toEqual([["A", ["l1"]], ["Wink", ["n1"]]]);
    expect(shownState(runs[1]!, new Set())).toBe("ended");
  });

  it("lets DONE replace a stalled note", () => {
    const runs = workerRuns([
      launch("l1", 1, "A | GPT-6 Astra | high"),
      note("n1", 2, STALLED, "A | GPT-6 Astra | high"),
      note("n2", 3, report("DONE", "A"), "A | GPT-6 Astra | high"),
    ]);
    expect(runs[0]).toMatchObject({ state: "done", provider: "codex" });
  });

  it("reads a stalled, limit, waiting or blocked newest note as waiting", () => {
    const label = "A | Gemini 3.8 | high";
    for (const text of [STALLED, LIMIT, "WAITING: this worker is stuck on an on-screen prompt (permission check).", report("BLOCKED", "A", "Which skin?")]) {
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

  it("a follow-up after done or failed is working until the next report", () => {
    const resume = (id: string, at: number): Message => ({
      id, at, role: "bot", kind: "launch",
      text: `Resumed A | Opus 5.5 | high\nLabel: A | Opus 5.5 | high\nWorking folder: C:\\repo\nSession: ${PANE}`,
    });
    const done = note("n1", 2, report("DONE", "A"), "A | Opus 5.5 | high");
    const again = note("n2", 4, report("DONE", "A", "still done"), "A | Opus 5.5 | high");
    const working = workerRuns([launch("l1", 1, "A | Opus 5.5 | high"), done, resume("r1", 3)]);
    expect(working).toHaveLength(1);
    expect(working[0]).toMatchObject({ state: "working", messageIds: ["l1", "n1", "r1"] });
    expect(working[0]!.notes.map((n) => n.id)).toEqual(["n1"]);
    const settled = workerRuns([launch("l1", 1, "A | Opus 5.5 | high"), done, resume("r1", 3), again]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ state: "done", messageIds: ["l1", "n1", "r1", "n2"] });
    const failed = workerRuns([
      launch("l1", 1, "A | Opus 5.5 | high"),
      note("n1", 2, report("FAIL", "A"), "A | Opus 5.5 | high"),
      resume("r1", 3),
    ]);
    expect(failed[0]!.state).toBe("working");
  });

  it("starts a run from a resume whose launch is not loaded, without a second row or a moved anchor", () => {
    const resume = (id: string, at: number, session = PANE): Message => ({
      id, at, role: "bot", kind: "launch",
      text: `Resumed A | Opus 5.5 | high\nLabel: A | Opus 5.5 | high\nWorking folder: C:\\repo\nSession: ${session}`,
    });
    const alone = workerRuns([resume("r1", 5)])[0]!;
    expect(alone).toMatchObject({ nick: "A", model: "Opus 5.5", state: "working", sessionId: PANE, messageIds: ["r1"] });

    const done = note("n1", 2, report("DONE", "A"), "A | Opus 5.5 | high");
    const followed = resume("r1", 3);
    const loaded = workerRuns([launch("l1", 1, "A | Opus 5.5 | high"), done, followed])[0]!;
    const withLaunch = workerAnchors([{ run: loaded }], [launch("l1", 1, "A | Opus 5.5 | high"), done, followed]);
    expect(withLaunch.get("l1")?.run.id).toBe(loaded.id);
    expect(withLaunch.get("r1")).toBeNull();

    const paged = workerRuns([done, followed])[0]!;
    expect(workerRuns([done, followed])).toHaveLength(1);
    const withoutLaunch = workerAnchors([{ run: paged }], [done, followed]);
    expect(withoutLaunch.get("n1")?.run.id).toBe(paged.id);
    expect(withoutLaunch.get("r1")).toBeNull();
    expect(paged.messageIds).toEqual(["n1", "r1"]);
  });

  it("settles a resumed run when its pane reports under another nickname", () => {
    const label = "GP-1 | Opus 5.5 | high";
    const messages = [
      launch("l1", 1, label),
      note("n1", 2, report("DONE", "GP-1"), label),
      resume("r1", 3, label),
      note("n2", 4, report("DONE", "GP-1B"), label),
    ];
    const runs = workerRuns(messages);
    expect(runs.map((r) => [r.nick, r.state, r.messageIds])).toEqual([
      ["GP-1", "done", ["l1", "n1", "r1"]],
      ["GP-1B", "done", ["n2"]],
    ]);
    const anchors = workerAnchors(runs.map((run) => ({ run })), messages);
    expect(anchors.get("l1")?.run.id).toBe(runs[0]!.id);
    expect(anchors.get("r1")).toBeNull();
  });

  it("omits a resume-only run after its pane reports under another nickname", () => {
    const label = "GP-1 | Opus 5.5 | high";
    const runs = workerRuns([
      resume("r1", 1, label),
      note("n1", 2, report("DONE", "GP-1B"), label),
    ]);
    expect(runs.map((r) => [r.nick, r.state, r.messageIds])).toEqual([
      ["GP-1B", "done", ["n1"]],
    ]);
  });

  it("only settles a resumed run on a report from its own pane", () => {
    const label = "GP-1 | Opus 5.5 | high";
    const messages = [
      launch("l1", 1, label),
      note("n1", 2, report("DONE", "GP-1"), label),
      resume("r1", 3, label),
      note("n2", 4, report("DONE", "GP-1B"), label, OTHER),
    ];
    expect(workerRuns(messages).map((r) => [r.nick, r.state])).toEqual([
      ["GP-1", "working"], ["GP-1B", "done"],
    ]);
    const settled = workerRuns([...messages, note("n3", 5, report("DONE", "GP-1C"), label)]);
    expect(settled[0]).toMatchObject({ nick: "GP-1", state: "done", messageIds: ["l1", "n1", "r1"] });
  });

  it("stays done when a plain launch repeats after the report", () => {
    const runs = workerRuns([
      launch("l1", 1, "A | Opus 5.5 | high"),
      note("n1", 2, report("DONE", "A"), "A | Opus 5.5 | high"),
      launch("l2", 3, "A | Opus 5.5 | high"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "done", messageIds: ["l1", "l2", "n1"] });
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
    expect(parseWorkerLabel("NICK | Fable 5.1 | high")).toEqual({ nick: "NICK", model: "Fable 5.1", effort: "high" });
    expect(parseWorkerLabel("NICK")).toEqual({ nick: "NICK", model: null, effort: null });
    expect(parseWorkerLabel(null)).toEqual({ nick: null, model: null, effort: null });
  });

  it.each([
    ["SETTINGS-LIST | Muse 1.3 | max", "max"],
    ["A | Opus 5.5 | high", "high"],
    ["A | Opus 5.5 | HIGH", "high"],
    ["A | Opus 5.5 | Max", "max"],
    ["A | Opus 5.5 | minimal", "minimal"],
    ["A | Opus 5.5 | low", "low"],
    ["A | Opus 5.5 | medium", "medium"],
    ["A | Opus 5.5 | Extra High", "xhigh"],
    ["A | Opus 5.5 | extra-high", "xhigh"],
    ["A | Opus 5.5 | x-high", "xhigh"],
    ["DUO-FIX | opus-5.5 | high API", "high"],
    ["A | Opus 5.5 | x-high API", "xhigh"],
    ["A | Opus 5.5 | Extra High API", "xhigh"],
  ])("reads the effort of %s as %s", (label, effort) => {
    expect(parseWorkerLabel(label).effort).toBe(effort);
  });

  it.each([
    "LANE-189A | script | -",
    "A | Opus 5.5 | ",
    "A | Opus 5.5",
    "A | Opus 5.5 | turbo",
    "A | Opus 5.5 | highest",
    "NICK",
  ])("reads no effort from %s", (label) => {
    expect(parseWorkerLabel(label).effort).toBeNull();
  });
});

describe("workerProvider", () => {
  it.each([
    ["Sonnet 5.5", "claudeAgent"], ["Opus 5.5", "claudeAgent"], ["Fable 5.1", "claudeAgent"],
    ["Opus5.5", "claudeAgent"], ["opus-5-5", "claudeAgent"], ["Sonnet5.5", "claudeAgent"], ["Haiku5", "claudeAgent"],
    ["GPT6.1", "codex"], ["gpt-6.1-sol", "codex"], ["Grok4.7", "grokAgent"], ["Gemini4", "geminiAgent"],
    ["GPT-6 Astra", "codex"], ["GPT-6.1 Sol", "codex"], ["Astra", "codex"], ["Sol", "codex"], ["Terra", "codex"], ["Luna", "codex"],
    ["Muse 1.3", "museAgent"], ["Argon", "geminiAgent"], ["Flash 3.8", "geminiAgent"], ["gemini-4-argon-high", "geminiAgent"],
    ["Grok 4.7", "grokAgent"], ["Gemini 3.8", "geminiAgent"], ["script", "script"], ["Mystery 2", null],
    ["solid", null], ["metadata", null], ["lunar", null], ["opuslike", null], ["megagpt6", null], ["geminiature", null],
    ["argonaut", null], ["flashy", null],
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

  const label = "A | Opus 5.5 | high";
  const listed = (messages: Message[], changedAt: number) => {
    const live = new Set([PANE]);
    const changed = new Map([[PANE, changedAt]]);
    return listedRuns(workerRuns(messages).map((run) => ({ run, state: shownState(run, live, changed) })), live).map((shown) => shown.state);
  };

  it("lists a run working once its pane's screen moves on after a stall, limit or prompt note", () => {
    for (const text of [STALLED, LIMIT, "WAITING: this worker is stuck on an on-screen prompt (permission check)."]) {
      const messages = [launch("l1", 1_000, label), note("n1", 200_000, text, label)];
      expect(listed(messages, 1_000)).toEqual(["waiting"]);
      expect(listed(messages, 300_000)).toEqual(["working"]);
    }
  });

  it("keeps the screen change that raised a prompt note from reading as the pane moving on", () => {
    const messages = [launch("l1", 1_000, label), note("n1", 200_000, "WAITING: this worker is stuck on an on-screen prompt (permission check).", label)];
    expect(listed(messages, 210_000)).toEqual(["waiting"]);
  });

  it("keeps a BLOCKED report waiting whatever its pane's screen does", () => {
    expect(listed([launch("l1", 1_000, label), note("n1", 200_000, report("BLOCKED", "A", "Which skin?"), label)], 300_000)).toEqual(["waiting"]);
  });

  it("leaves done and failed runs as they are when their pane's screen moves", () => {
    expect(listed([launch("l1", 1_000, label), note("n1", 200_000, report("DONE", "A"), label)], 300_000)).toEqual(["done"]);
    expect(listed([launch("l1", 1_000, label), note("n1", 200_000, report("FAIL", "A"), label)], 300_000)).toEqual(["failed"]);
  });

  it("goes back to waiting when a resumed pane stalls again", () => {
    const resumed = [launch("l1", 1_000, label), note("n1", 200_000, STALLED, label)];
    expect(listed(resumed, 450_000)).toEqual(["working"]);
    expect(listed([...resumed, note("n2", 600_000, STALLED, label)], 450_000)).toEqual(["waiting"]);
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

  it("lists AI workers before scripts in the same state, oldest first within each kind", () => {
    const runs = workerRuns([
      launch("s1", 1, "S1 | script", "11111111"),
      launch("b", 2, "B | Grok 4.7 | high", "22222222"),
      launch("c", 3, "C | Grok 4.7 | high", "33333333"),
      launch("s2", 4, "S2 | script", "44444444"),
    ]);
    const sorted = runs.map((run) => ({ run, state: shownState(run, null) })).sort(byUrgency);
    expect(sorted.map((r) => r.run.nick)).toEqual(["B", "C", "S1", "S2"]);
  });

  it("keeps a waiting script before working AI workers, AI before script within working", () => {
    const runs = workerRuns([
      launch("ws", 1, "WS | script", "11111111"),
      launch("wa", 2, "WA | Grok 4.7 | high", "22222222"),
      launch("ts", 3, "TS | script", "33333333"),
      note("tn", 4, STALLED, "TS | script", "33333333"),
    ]);
    const sorted = runs.map((run) => ({ run, state: shownState(run, null) })).sort(byUrgency);
    expect(sorted.map((r) => r.run.nick)).toEqual(["TS", "WA", "WS"]);
  });
});

describe("listedRuns", () => {
  const runs = () => workerRuns([
    launch("a", 1, "WORK | Opus 5.5 | high", "aaaaaaaa-1"),
    launch("b", 2, "WAIT | Opus 5.5 | high", "bbbbbbbb-1"),
    note("bn", 3, STALLED, "WAIT | Opus 5.5 | high", "bbbbbbbb-1"),
    launch("c", 4, "COPY | Opus 5.5 | high", "cccccccc-1"),
    note("cn", 5, report("DONE", "COPY"), "COPY | Opus 5.5 | high", "cccccccc-1"),
    launch("d", 6, "SHIP | Opus 5.5 | high", "dddddddd-1"),
    note("dn", 7, report("FAIL", "SHIP"), "SHIP | Opus 5.5 | high", "dddddddd-1"),
  ]).map((run) => ({ run, state: shownState(run, null) }));

  it("keeps every live pane, including a done one, and drops a closed working pane", () => {
    const listed = listedRuns(runs(), new Set(["bbbbbbbb-1", "cccccccc-1", "dddddddd-1"]));
    expect(listed.map((shown) => shown.run.nick)).toEqual(["WAIT", "SHIP", "COPY"]);
  });

  it("falls back to working and waiting when liveness is unknown", () => {
    const listed = listedRuns(runs(), null);
    expect(listed.map((shown) => shown.run.nick)).toEqual(["WAIT", "WORK"]);
  });

  it("lists a renamed pane once under its newest report nickname", () => {
    const runs = workerRuns([
      launch("l1", 1, "GO-GOOGLE | GPT-6.1 Sol | high"),
      note("n1", 2, report("BLOCKED", "CHAIN-GP2"), "GO-GOOGLE | GPT-6.1 Sol | high"),
    ]).map((run) => ({ run, state: run.state }));
    expect(listedRuns(runs, new Set([PANE])).map((shown) => shown.run.nick)).toEqual(["CHAIN-GP2"]);
    expect(listedRuns(runs, null).map((shown) => shown.run.nick)).toEqual(["CHAIN-GP2", "GO-GOOGLE"]);
  });

  it.each(["launch", "resume", "note"])("keeps the run with the newest %s event when a pane is reused", (kind) => {
    const label = "A | Opus 5.5 | high";
    const latest = kind === "launch" ? launch("a2", 5, label) : kind === "resume" ? resume("a2", 5, label) : note("a2", 5, report("DONE", "A"), label);
    const runs = workerRuns([
      launch("a1", 1, label),
      note("an", 2, report("DONE", "A"), label),
      launch("b1", 3, "B | Opus 5.5 | high"),
      note("bn", 4, report("BLOCKED", "B"), "B | Opus 5.5 | high"),
      latest,
      launch("side", 6, "SIDE | Opus 5.5 | high", OTHER),
    ]).map((run) => ({ run, state: run.state }));
    const listed = listedRuns(runs, new Set([PANE, OTHER]));
    expect(listed).toHaveLength(2);
    expect(listed.find((shown) => shown.run.sessionId === PANE)?.run.nick).toBe("A");
    expect(listed.find((shown) => shown.run.sessionId === OTHER)).toBe(runs.find((shown) => shown.run.sessionId === OTHER));
    expect(listed.find((shown) => shown.run.nick === "A")?.run.at).toBe(1);
  });

  it("uses event time when notes from a reused pane arrive out of order", () => {
    const runs = workerRuns([
      launch("a1", 1, "A | script"),
      launch("b1", 2, "B | script"),
      note("an", 4, report("DONE", "A"), "A | script"),
      note("bn", 3, report("BLOCKED", "B"), "B | script"),
    ]).map((run) => ({ run, state: run.state }));
    expect(listedRuns(runs, new Set([PANE])).map((shown) => shown.run.nick)).toEqual(["A"]);
  });

  it("uses transcript order for equal-time events from a reused pane", () => {
    const runs = workerRuns([
      launch("a1", 1, "A | script"),
      launch("b1", 2, "B | script"),
      note("bn", 3, report("BLOCKED", "B"), "B | script"),
      note("an", 3, report("DONE", "A"), "A | script"),
    ]).map((run) => ({ run, state: run.state }));
    expect(listedRuns(runs, new Set([PANE])).map((shown) => shown.run.nick)).toEqual(["A"]);
  });

  it("only confirms a launch session after pane liveness loads", () => {
    const run = workerRuns([launch("l1", 1, "A | Opus 5.5 | high")])[0]!;
    expect(listedSessionId(run, null)).toBeNull();
    expect(listedRuns([{ run, state: run.state }], null)).toHaveLength(1);
    expect(listedSessionId(run, new Set([PANE]))).toBe(PANE);
    expect(listedSessionId(run, new Set([OTHER]))).toBeNull();
  });

  it("lists a note-only run when one live pane starts with its pane id", () => {
    const run = workerRuns([note("n1", 5, report("BLOCKED", "OLD-JOB"), "OLD-JOB | Opus 5.5 | high", "5d09c0d0-not-loaded")])[0]!;
    expect(run.sessionId).toBeNull();
    const live = new Set(["5d09c0d0-not-loaded"]);
    expect(listedRuns([{ run, state: run.state }], live).map((shown) => shown.run.nick)).toEqual(["OLD-JOB"]);
    expect(listedSessionId(run, live)).toBe("5d09c0d0-not-loaded");
    const both = new Set(["5d09c0d0-a", "5d09c0d0-b"]);
    expect(listedRuns([{ run, state: run.state }], both).map((shown) => shown.run.sessionId)).toEqual(["5d09c0d0-a", "5d09c0d0-b"]);
    expect(listedSessionId(run, both)).toBeNull();
  });

  describe("placeholders", () => {
    const WORK = "aaaaaaaa-1";
    const bare = (ids: string[], labels?: ReadonlyMap<string, string>) => listedRuns(runs(), new Set([WORK, ...ids]), labels);

    it("adds one working row for a live pane with no transcript run", () => {
      const [first, extra] = bare(["eeeeeeee-1"]);
      expect(first!.run.nick).toBe("WORK");
      expect(extra).toMatchObject({ state: "working", run: { id: "pane:eeeeeeee-1", nick: "eeeeeeee", model: null, provider: null, sessionId: "eeeeeeee-1", pane8: "eeeeeeee", messageIds: [], notes: [] } });
    });

    it("titles the row with the pane label and takes its model and provider", () => {
      const [, extra] = bare(["eeeeeeee-1"], new Map([["eeeeeeee-1", "SIDE | Opus 5.5 | high"]]));
      expect(extra!.run).toMatchObject({ nick: "SIDE", model: "Opus 5.5", provider: "claudeAgent" });
    });

    it("falls back to the pane id for a blank label", () => {
      expect(bare(["eeeeeeee-1"], new Map([["eeeeeeee-1", ""]]))[1]!.run.nick).toBe("eeeeeeee");
    });

    it("sorts after the real working rows", () => {
      expect(bare(["eeeeeeee-1"]).map((shown) => shown.run.nick)).toEqual(["WORK", "eeeeeeee"]);
    });

    it("lists every live pane up to the 16 per bot cap", () => {
      const ids = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(8, "0")}-1`);
      const listed = listedRuns([], new Set(ids));
      expect(listed).toHaveLength(16);
      expect(new Set(listed.map((shown) => shown.run.id)).size).toBe(16);
    });

    it("lists nothing extra while liveness is unknown", () => {
      expect(listedRuns([], null)).toEqual([]);
    });

    it("never stands in for a transcript run", () => {
      expect(latestPaneRun([], WORK)).toBeUndefined();
    });
  });
});
