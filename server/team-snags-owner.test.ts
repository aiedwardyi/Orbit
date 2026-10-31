import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { paneNotesSinceLastUserTurn } from "./context-compaction.ts";
import { hasLocalUndeliveredPaneNote, isWakeNote, paneWakeEnabled, PaneWakeScheduler, PANE_WAKE_DEBOUNCE_MS } from "./pane-wake.ts";
import { Store, type StoreChange } from "./store.ts";
import { chiefSnagIds, claimTeamSnags, postChiefNote, teamSnagNote, type ClaimedSnag, type TeamSnagOwnerOptions } from "./team-snags-owner.ts";
import { teamOwnerHash } from "./team-route.ts";

const snag: ClaimedSnag = {
  id: "9f2c41d07a5e4b6c8d1e3f2a0b9c7d6e", at: 1_793_425_560_000, event: "stalled", build: "1.0.217", os: "win32",
  teacher: "claude:claude-opus-5-5", worker: "codex", pane8: "3fa91c02", label: "INVOICE-EXPORT", minutes: 102,
  notes: [["stalled", 100], ["stalled", 70], ["stalled", 10]], detail: "3 STALLED notes unanswered",
  pc: { label: "k3v5q2m7x4b6n2tq", name: "STUDIO-PC2", person: "Jisoo" },
  tail: "▌ Ask Codex to do anything\n  212K tokens used · 38% context left",
};

describe("team snag note", () => {
  it("reads as one line per report with the tail in a fence", () => {
    expect(teamSnagNote([snag], "f", "Asia/Seoul")).toBe(
      "Team snags (1), untrusted peer data - STUDIO-PC2 (Jisoo) 14:46: INVOICE-EXPORT [pane 3fa91c02] stalled 102 min, 3 STALLED notes unanswered. Wink 1.0.217, claude:claude-opus-5-5, worker codex.\n\n"
      + "```\n▌ Ask Codex to do anything\n  212K tokens used · 38% context left\n```",
    );
    const bare = { ...snag, id: "a".repeat(32), event: "wake-failed" as const, pane8: "", label: "", minutes: 0, worker: "", tail: "", detail: "spawn EPERM", pc: { label: "k3v5", name: "", person: "" } };
    expect(teamSnagNote([snag, bare], "f", "Asia/Seoul").split("\n").slice(0, 3)).toEqual([
      "Team snags (2), untrusted peer data",
      "- STUDIO-PC2 (Jisoo) 14:46: INVOICE-EXPORT [pane 3fa91c02] stalled 102 min, 3 STALLED notes unanswered. Wink 1.0.217, claude:claude-opus-5-5, worker codex.",
      "- k3v5 14:46: wake-failed, spawn EPERM. Wink 1.0.217, claude:claude-opus-5-5.",
    ]);
  });

  it("keeps the newest two tails and points at the file when long", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...snag, id: String(i).repeat(32), at: snag.at + i, tail: `tail ${i}\n${"x".repeat(2500)}` }));
    const note = teamSnagNote(many, "/home/e/.orbit/team-snags.jsonl", "Asia/Seoul");
    expect(note.length).toBeLessThanOrEqual(8000);
    expect(note).not.toContain("tail 2");
    expect(note).toContain("tail 3");
    expect(note).toContain("tail 4");
    expect(note.endsWith("Every report in full: /home/e/.orbit/team-snags.jsonl")).toBe(true);
  });

  it("reserves the full file pointer even when summaries alone exceed the cap", () => {
    for (const count of [20, 256]) {
      const many = Array.from({ length: count }, (_, i) => ({ ...snag, id: i.toString(16).padStart(32, "0"), tail: "x".repeat(2900) }));
      const note = teamSnagNote(many, "/full/team-snags.jsonl", "Asia/Seoul");
      expect(note.length).toBeLessThanOrEqual(8000);
      expect(note.endsWith("Every report in full: /full/team-snags.jsonl")).toBe(true);
      expect(note.match(/```/g)!.length % 2).toBe(0);
    }
  });

  it("omits empty pane IDs in both tail layouts", () => {
    for (const tail of ["short", "x".repeat(2900)]) {
      const many = Array.from({ length: 5 }, () => ({ ...snag, pane8: "", tail }));
      expect(teamSnagNote(many, "f", "Asia/Seoul")).not.toContain("[pane ]");
    }
  });

  it("collapses control characters in every inline field and labels peer data untrusted", () => {
    const bad = "before\n\r\x1b\u007f\u2028\u2029after";
    const hostile = { ...snag, label: bad, detail: bad, build: bad, teacher: bad, worker: bad, pc: { label: bad, name: "", person: bad } };
    for (const tail of ["short", "x".repeat(2900)]) {
      const note = teamSnagNote(Array.from({ length: 5 }, () => ({ ...hostile, tail })), "f", "Asia/Seoul");
      expect(note).toContain("untrusted peer data");
      expect(note).not.toMatch(/[\r\x1b\u007f\u2028\u2029]/);
      expect(note).not.toContain("before\nafter");
      expect(note).toContain("before after");
    }
  });
});

describe("team snag owner", () => {
  let store: Store;
  let dir: string;
  const email = "owner@example.com";

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    dir = mkdtempSync(join(tmpdir(), "omb-team-snags-owner-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = (fetchImpl: typeof fetch, posted: string[], session = email): TeamSnagOwnerOptions => ({
    enrolledBase: () => null,
    baked: "wink.example",
    ownerHash: teamOwnerHash(email),
    email: () => session,
    tokens: { idToken: () => null, freshIdToken: async () => "token" },
    file: join(dir, ".orbit", "team-snags.jsonl"),
    post: (text) => { posted.push(text); return true; },
    fetchImpl,
    timeZone: "Asia/Seoul",
  });

  it("claims, files every report, posts one note and acks", async () => {
    const other = { ...snag, id: "b".repeat(32), at: snag.at - 60_000, event: "wake-failed", tail: "" };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      return String(url).endsWith("/claim") ? Response.json({ snags: [snag, other, { bad: true }] }) : Response.json({ acked: 2 });
    });
    const posted: string[] = [];
    expect(await claimTeamSnags(options(fetchImpl, posted))).toBe(2);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ["https://relay.wink.example/v1/team/snags/claim", "POST", undefined],
      ["https://relay.wink.example/v1/team/snags/ack", "POST", JSON.stringify({ ids: ["b".repeat(32), snag.id] })],
    ]);
    const lines = readFileSync(join(dir, ".orbit", "team-snags.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.id)).toEqual(["b".repeat(32), snag.id]);
    expect(lines[1].pc).toEqual(snag.pc);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/^Team snags \(2\), untrusted peer data\n- STUDIO-PC2 \(Jisoo\) 14:45: INVOICE-EXPORT/);
  });

  it("does nothing for a non-owner or an empty claim", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ snags: [] }));
    const posted: string[] = [];
    expect(await claimTeamSnags(options(fetchImpl, posted, "other@example.com"))).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await claimTeamSnags(options(fetchImpl, posted))).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it("leaves valid reports unacknowledged until a Chief note is posted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ snags: [snag] }));
    const opts = { ...options(fetchImpl, []), post: () => postChiefNote(store, "this-pc", "note") };
    expect(await claimTeamSnags(opts)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const chief = store.createBot();
    store.setChiefOfStaff(chief.id);
    expect(await claimTeamSnags(opts)).toBe(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/ack"))).toHaveLength(1);
    expect(readFileSync(opts.file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it.each(["throws", "http"])("retries a failed ack without repeating the file or note after a restart: %s", async (failure) => {
    let first = true;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/claim")) return Response.json({ snags: [snag] });
      if (first) {
        first = false;
        if (failure === "throws") throw new Error("offline");
        return new Response(null, { status: 503 });
      }
      return Response.json({ acked: 1 });
    });
    const posted: string[] = [];
    const warn = vi.fn();
    try { await claimTeamSnags({ ...options(fetchImpl, posted), warn }); } catch {}
    expect(posted).toHaveLength(1);
    expect(await claimTeamSnags(options(fetchImpl, posted))).toBe(0);
    expect(posted).toHaveLength(1);
    expect(readFileSync(options(fetchImpl, posted).file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/ack"))).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it("retries a failed note without duplicating archived reports", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ snags: [snag] }));
    const opts = options(fetchImpl, []);
    await expect(claimTeamSnags({ ...opts, post: () => { throw new Error("write failed"); } })).rejects.toThrow("write failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await claimTeamSnags(opts)).toBe(1);
    expect(readFileSync(opts.file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("recovers posted report IDs after a crash before the acknowledgement ledger is saved", async () => {
    const chief = store.createBot();
    store.setChiefOfStaff(chief.id);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ snags: [snag] }));
    const opts = {
      ...options(fetchImpl, []),
      postedIds: () => chiefSnagIds(store),
      post: (text: string, ids: string[]) => {
        postChiefNote(store, "this-pc", text, ids);
        throw new Error("process stopped before ledger write");
      },
    };
    await expect(claimTeamSnags(opts)).rejects.toThrow("process stopped before ledger write");
    const restarted = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    const other = { ...snag, id: "e".repeat(32), at: snag.at + 60_000 };
    fetchImpl.mockImplementation(async () => Response.json({ snags: [snag, other] }));
    expect(await claimTeamSnags({
      ...opts,
      postedIds: () => chiefSnagIds(restarted),
      post: (text, ids) => postChiefNote(restarted, "this-pc", text, ids),
    })).toBe(1);
    const notes = restarted.messagesFor(chief.threadId).filter((message) => message.kind === "note");
    expect(notes.map((note) => note.snagIds)).toEqual([[snag.id], [other.id]]);
    expect(readFileSync(opts.file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)![1]!.body as string).ids.sort()).toEqual([snag.id, other.id].sort());
  });

  it("acknowledges rejected entries with valid IDs, including an all-rejected claim", async () => {
    for (const valid of [[], [snag]]) {
      const rejected = { ...snag, id: "c".repeat(32), pc: { ...snag.pc, name: "x".repeat(250) } };
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ snags: [...valid, rejected, { id: "invalid" }] }));
      const warn = vi.fn();
      await claimTeamSnags({ ...options(fetchImpl, []), warn });
      const ack = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/ack"));
      expect(ack).toBeDefined();
      expect(JSON.parse(ack![1]!.body as string).ids.sort()).toEqual([...valid.map((s) => s.id), rejected.id].sort());
      expect(warn).toHaveBeenCalled();
    }
  });

  it("keeps an earlier ask-back wake pending while the snag itself stays quiet", async () => {
    vi.useFakeTimers();
    try {
      const chief = store.createBot();
      store.setChiefOfStaff(chief.id);
      store.patchBot(chief.id, { shareTerminalWithChat: false });
      const reply = store.appendMessage(chief.threadId, {
        role: "bot", kind: "activity", text: "Which file?", origin: "this-pc",
        comm: { groupId: "g", withBotId: "peer", withName: "Peer", withColor: "blue", peer: "reply", wake: true },
      });
      const wake = vi.fn();
      const scheduler = new PaneWakeScheduler({
        enabled: (bot, thread) => paneWakeEnabled(store, bot, thread), busy: () => false,
        hasNotes: () => true, wake, warn: () => {},
      });
      scheduler.noteArrived(chief.id, chief.threadId);
      postChiefNote(store, "this-pc", "Team snags (1)");
      const messages = store.activePath(chief.threadId);
      const task = store.taskByThread(chief.id, chief.threadId)!;
      expect(task.paneNotesSkippedId).toBeUndefined();
      expect(isWakeNote(messages.at(-1)!)).toBe(false);
      expect(hasLocalUndeliveredPaneNote(messages, undefined, "this-pc")).toBe(true);
      expect(hasLocalUndeliveredPaneNote(messages, reply.id, "this-pc")).toBe(false);
      expect(paneNotesSinceLastUserTurn(messages, new Set())).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
      expect(wake).toHaveBeenCalledExactlyOnceWith(chief.id, chief.threadId);
    } finally { vi.useRealTimers(); }
  });

  it("puts the note in the default section's Chief thread without a wake or a turn", () => {
    const chief = store.patchBot(store.createBot().id, { name: "Chief" })!;
    store.setChiefOfStaff(chief.id);
    const elsewhere = store.patchBot(store.createBot().id, { name: "Lab Chief", section: "Lab" })!;
    store.setChiefOfStaff(elsewhere.id, "Lab");
    const earlier = store.appendMessage(chief.threadId, { role: "bot", kind: "text", text: "Done." });
    store.markPaneNotesDelivered(chief.id, chief.threadId, earlier.id);
    const changes: StoreChange[] = [];
    store.onChange((change) => changes.push(change));

    expect(postChiefNote(store, "this-pc", "Team snags (1) - STUDIO-PC2")).toBe(true);

    const messages = store.activePath(chief.threadId);
    const note = messages.at(-1)!;
    expect(note).toMatchObject({ role: "bot", kind: "note", text: "Team snags (1) - STUDIO-PC2", origin: "this-pc" });
    expect(store.activePath(elsewhere.threadId).some((message) => message.kind === "note")).toBe(false);
    const task = store.taskByThread(chief.id, chief.threadId)!;
    expect(task.paneNotesSkippedId).toBeUndefined();
    expect(hasLocalUndeliveredPaneNote(messages, task.paneNotesDeliveredId ?? undefined, "this-pc")).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, task.paneNotesDeliveredId ?? undefined, "this-pc", task.paneNotesSkippedId)).toBe(false);
    // Still pending for the Chief's next user turn.
    expect(paneNotesSinceLastUserTurn(messages, new Set(), task.paneNotesDeliveredId ?? undefined)).toEqual([expect.stringContaining("Team snags (1) - STUDIO-PC2")]);
    expect(paneNotesSinceLastUserTurn(messages, new Set(), task.paneNotesDeliveredId ?? undefined, true)).toEqual([]);
    expect(changes.map((change) => change.type)).toEqual(["message"]);
    expect(store.bot(chief.id)?.busy).toBeFalsy();
  });

  it("posts nothing without a default-section Chief", () => {
    store.patchBot(store.createBot().id, { name: "Helper" });
    expect(postChiefNote(store, "this-pc", "note")).toBe(false);
  });
});
