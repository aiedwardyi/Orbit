import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { parsePaneNote } from "../../shared/pane-note";
import { notePreview, noteText, paneReports } from "./pane-note";

const BOT = "61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const stored = (text: string, label: string | null = "QCARD-FIX | Opus 5.5 | high") =>
  `[pane bc9c674b]${label ? ` [${label}]` : ""} from Wink (${BOT}): ${text}`;

describe("parsePaneNote", () => {
  it("splits a DONE report into status and the worker's words", () => {
    expect(parsePaneNote(stored("DONE QCARD-FIX branch=fix/question-card sha=3623665c dirty=no\nThe card is fixed. Tests pass."))).toEqual({
      pane8: "bc9c674b",
      label: "QCARD-FIX | Opus 5.5 | high",
      nick: "QCARD-FIX",
      status: "done",
      alert: null,
      body: "The card is fixed. Tests pass.",
    });
  });

  it("reads FAIL and BLOCKED reports", () => {
    const failed = parsePaneNote(stored("FAIL QCARD-FIX branch=none sha=none dirty=unknown\nThe build broke."));
    expect([failed.status, failed.nick, failed.body]).toEqual(["failed", "QCARD-FIX", "The build broke."]);
    const blocked = parsePaneNote(stored("BLOCKED QCARD-FIX branch=fix/x sha=abc1234 dirty=yes\nWhich skin should win?"));
    expect([blocked.status, blocked.body]).toEqual(["blocked", "Which skin should win?"]);
  });

  it("keeps a report with no text as a status alone", () => {
    expect(parsePaneNote(stored("DONE QCARD-FIX branch=x sha=y dirty=no"))).toMatchObject({ status: "done", body: "" });
  });

  it("turns a STALLED watcher note into an alert and drops its instructions", () => {
    const note = parsePaneNote(stored("STALLED: no screen change for 2 min and no report. It may be stuck on a usage limit, a menu or an error. terminal_read its pane, then act or tell the user. Last lines:\n> npm test\nPASS"));
    expect(note).toMatchObject({ status: null, alert: { kind: "stalled", minutes: 2 }, body: "" });
    expect(noteText(note, t)).toBe("No screen change for 2 minutes. It may be stuck.");
    expect(noteText({ ...note, alert: { kind: "stalled", minutes: 1 } }, t)).toBe("No screen change for 1 minute. It may be stuck.");
  });

  it("turns a WAITING hook note into an alert", () => {
    const note = parsePaneNote(stored("WAITING: this worker is stuck on an on-screen prompt (permission check or question). terminal_read its pane, then answer with key presses or tell the user."));
    expect(note.alert).toEqual({ kind: "waiting" });
    expect(noteText(note, t)).toBe("Waiting on a prompt in its terminal.");
  });

  it("falls back to the free text minus the prefix", () => {
    expect(parsePaneNote(stored("halfway, tests running"))).toMatchObject({ status: null, alert: null, nick: null, body: "halfway, tests running" });
    expect(parsePaneNote(stored("WAITING: on CI")).body).toBe("WAITING: on CI");
    expect(parsePaneNote(stored("FAIL to build the docs")).status).toBeNull();
    expect(parsePaneNote(stored("FAIL BUILD"))).toMatchObject({ status: null, nick: null, body: "FAIL BUILD" });
  });

  it("reads a note without a label", () => {
    expect(parsePaneNote(stored("still running", null))).toMatchObject({ pane8: "bc9c674b", label: null, body: "still running" });
  });

  it("marks a truncated note with an ellipsis", () => {
    expect(parsePaneNote(stored("DONE N branch=x sha=y dirty=no\nlong report\n[truncated]")).body).toBe("long report…");
  });

  it("reads the raw text a pane posted, without the stored prefix", () => {
    expect(parsePaneNote("FAIL NICK branch=x sha=y dirty=no\r\nwhy")).toMatchObject({ pane8: null, status: "failed", nick: "NICK", body: "why" });
  });
});

describe("notePreview", () => {
  it("leads with the status word", () => {
    expect(notePreview(parsePaneNote(stored("DONE N branch=x sha=y dirty=no\nAll green.\nShipped.")), t)).toBe("Finished: All green. Shipped.");
    expect(notePreview(parsePaneNote(stored("BLOCKED N branch=x sha=y dirty=no")), t)).toBe("Needs an answer");
  });
});

describe("paneReports", () => {
  it("keeps the newest report per pane and skips watcher notes", () => {
    const note = (id: string, text: string): Message => ({ id, at: 1, role: "bot", kind: "note", text: stored(text) });
    const reports = paneReports([
      note("n1", "FAIL N branch=x sha=y dirty=no\nfirst try"),
      note("n2", "DONE N branch=x sha=y dirty=no\nsecond try"),
      note("n3", "STALLED: no screen change for 3 min and no report. Last lines:\nx"),
    ]);
    expect([...reports.keys()]).toEqual(["bc9c674b"]);
    expect(reports.get("bc9c674b")?.body).toBe("second try");
  });
});
