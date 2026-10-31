import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { paneNotesSinceLastUserTurn } from "./context-compaction.ts";
import { hasLocalUndeliveredPaneNote } from "./pane-wake.ts";
import { Store, type StoreChange } from "./store.ts";
import { claimTeamSnags, postChiefNote, teamSnagNote, type ClaimedSnag, type TeamSnagOwnerOptions } from "./team-snags-owner.ts";
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
      "Team snags (1) - STUDIO-PC2 (Jisoo) 14:46: INVOICE-EXPORT [pane 3fa91c02] stalled 102 min, 3 STALLED notes unanswered. Wink 1.0.217, claude:claude-opus-5-5, worker codex.\n\n"
      + "```\n▌ Ask Codex to do anything\n  212K tokens used · 38% context left\n```",
    );
    const bare = { ...snag, id: "a".repeat(32), event: "wake-failed" as const, pane8: "", label: "", minutes: 0, worker: "", tail: "", detail: "spawn EPERM", pc: { label: "k3v5", name: "", person: "" } };
    expect(teamSnagNote([snag, bare], "f", "Asia/Seoul").split("\n").slice(0, 3)).toEqual([
      "Team snags (2)",
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
    post: (text) => posted.push(text),
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
    expect(posted[0]).toMatch(/^Team snags \(2\)\n- STUDIO-PC2 \(Jisoo\) 14:45: INVOICE-EXPORT/);
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
    expect(task.paneNotesSkippedId).toBe(note.id);
    // The boot sweep's own check: without the marker this note would wake the Chief.
    expect(hasLocalUndeliveredPaneNote(messages, task.paneNotesDeliveredId ?? undefined, "this-pc")).toBe(true);
    expect(hasLocalUndeliveredPaneNote(messages, task.paneNotesDeliveredId ?? undefined, "this-pc", task.paneNotesSkippedId)).toBe(false);
    // Still pending for the Chief's next user turn.
    expect(paneNotesSinceLastUserTurn(messages, new Set(), task.paneNotesDeliveredId ?? undefined)).toEqual([expect.stringContaining("Team snags (1) - STUDIO-PC2")]);
    expect(changes.map((change) => change.type)).toEqual(["message"]);
    expect(store.bot(chief.id)?.busy).toBeFalsy();
  });

  it("posts nothing without a default-section Chief", () => {
    store.patchBot(store.createBot().id, { name: "Helper" });
    expect(postChiefNote(store, "this-pc", "note")).toBe(false);
  });
});
