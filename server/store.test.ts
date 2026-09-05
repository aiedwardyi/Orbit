// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import type { ModelSelection } from "./contracts.ts";
import { peerAllowKey } from "./peer-approval-key.ts";
import { applyResolvedProjectFolder } from "./project-folder.ts";
import { Store, titleFromMessage, type BotRecord } from "./store.ts";
import * as taskState from "./task-state.ts";
import { readTaskResumePacket, type TaskResumePacket } from "./task-state.ts";
import { buildResumeFallback } from "./turn-context.ts";
import { workspaceDir } from "./workspace.ts";
import { readContextCompaction } from "../shared/context-compaction.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const taskPacket = (
  botId: string,
  threadId: string,
  overrides: Partial<TaskResumePacket> = {},
): TaskResumePacket => ({
  v: 1,
  threadId,
  botId,
  goal: "Prepare the weekly report",
  plan: [{ step: "Write the draft", status: "active" }],
  completed: [],
  evidence: [],
  artifacts: [],
  blockers: [],
  nextAction: "Write the draft",
  updatedAt: 100,
  updatedBy: "harness",
  flushReason: "progress",
  turnsAtWrite: 0,
  ...overrides,
});

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("createBot seeds an onboarding card without a fake chat bubble", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "options" });
    expect(messages[0].card?.options.length).toBeGreaterThan(1);
    expect(messages.some((message) => message.kind === "text")).toBe(false);
    expect(JSON.stringify(messages)).not.toMatch(/I'll handle|Nice to meet you|first piece of work/);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("createBot on packaged Windows defaults Runs-on to Off, not Local VM", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { host: { platform: "win32", packaged: true } });
    expect(bot.computer).toBe("off");
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].computer).toBe("off");
  });

  it("createBot still records an explicit Local VM opt-in on packaged Windows", () => {
    const store = new Store(selection);
    const bot = store.createBot({ computer: "vm" }, { host: { platform: "win32", packaged: true } });
    expect(bot.computer).toBe("vm");
  });

  it("createBot reads OMB_PACKAGED when host.packaged is omitted", () => {
    vi.stubEnv("OMB_PACKAGED", "1");
    try {
      const store = new Store(selection);
      const bot = store.createBot({}, { host: { platform: "win32" } });
      expect(bot.computer).toBe("off");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("createBot keeps Auto on packaged macOS so This computer can still be the fallback", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { host: { platform: "darwin", packaged: true } });
    expect(bot.computer).toBeUndefined();
  });

  it("createBot with a job starts with a useful profile and no lifestyle quiz", () => {
    const store = new Store(selection);
    const job = "Keep a weekly competitor brief with links and decisions.";
    const bot = store.createBot({}, { job });

    expect(bot.title).toBe(titleFromMessage(job));
    expect(bot.description).toBe(job);
    const messages = store.messagesFor(bot.threadId);
    expect(messages).toEqual([]);
    expect(JSON.stringify(messages)).not.toMatch(/I'll handle|first piece of work/);
  });

  it("dismisses the onboarding quiz when the user talks, and leaves live asks", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[0]!;
    expect(quiz.card?.dismissed).toBeUndefined();

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const ask = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === ask.id)?.card?.dismissed).toBeUndefined();
  });

  it("does not dismiss the quiz for bot-authored messages", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "still here" });
    expect(store.messagesFor(bot.threadId)[0]?.card?.dismissed).toBeUndefined();
  });

  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("addTaskUsage accumulates settled-turn totals per task and survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 1200, output: 300, cachedInput: 1000, costUsd: null })).toEqual({
      input: 1200,
      output: 300,
      cachedInput: 1000,
      costUsd: null,
      turns: 1,
      lastInput: 1200,
    });
    // a driver that never reports the cached share leaves it unchanged
    store.addTaskUsage(bot.id, bot.threadId, { input: 800, output: 100, costUsd: null });
    store.addTaskUsage(bot.id, bot.threadId, { input: Number.NaN, output: -20, cachedInput: -5, costUsd: null });
    // Providers occasionally report a cache count larger than input; keep the
    // persisted share physically possible so percentages cannot exceed 100%.
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 0, cachedInput: 20, costUsd: null });
    // a different thread never inherits another task's tally
    expect(store.addTaskUsage(bot.id, "no-such-thread", { input: 5, output: 5, costUsd: null })).toBeNull();

    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage).toEqual({
      input: 2010,
      output: 400,
      cachedInput: 1010,
      costUsd: null,
      turns: 4,
      lastInput: 10,
    });
  });

  it("remembers the last settled turn's input as the native session size signal", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 12_000, output: 80, costUsd: null })).toMatchObject({
      lastInput: 12_000,
    });
    store.addTaskUsage(bot.id, bot.threadId, { input: 88_000, output: 40, costUsd: null });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBe(88_000);
    // A turn that reports no tokens keeps the last real session-size signal.
    store.addTaskUsage(bot.id, bot.threadId, { costUsd: null });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBe(88_000);
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBe(88_000);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("defaults a new bot without an explicit color to red", () => {
    const store = new Store(selection);
    expect(store.createBot().color).toBe("red");
  });

  it("keeps an explicit stored green color instead of reminting red", () => {
    const store = new Store(selection);
    const bot = store.createBot({ color: "green" });
    expect(bot.color).toBe("green");
    expect(new Store(selection).bot(bot.id)?.color).toBe("green");
  });

  it("rotates colors across created bots and cycles back to red", () => {
    const store = new Store(selection);
    const colors = Array.from({ length: 11 }, () => store.createBot().color);
    expect(colors[0]).toBe("red");
    expect(colors[10]).toBe("red");
    expect(new Set(colors.slice(0, 10)).size).toBe(10);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("persists a channel's context when it is created", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Website launch", [bot.id], false, "Work");

    expect(channel.section).toBe("Work");
    expect(new Store(selection).group(channel.id)?.section).toBe("Work");
  });

  it("persists a channel's completed setup in the same create write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Launch", [bot.id], false, "Work", {
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      completed: true,
    });

    expect(channel).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupSkippedAt: null,
    });
    expect(channel.setupCompletedAt).toEqual(expect.any(Number));
    expect(new Store(selection).group(channel.id)).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupCompletedAt: channel.setupCompletedAt,
    });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("normalizes persisted cloud backends without changing valid or absent values", () => {
    const store = new Store(selection);
    const box = store.createBot();
    const vps = store.createBot();
    const invalid = store.createBot();
    const absent = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((bot) => bot.id === box.id)!.cloudBackend = "box";
    raw.find((bot) => bot.id === vps.id)!.cloudBackend = "vps";
    (raw.find((bot) => bot.id === invalid.id) as unknown as { cloudBackend: string }).cloudBackend = "daytona";
    delete raw.find((bot) => bot.id === absent.id)!.cloudBackend;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(box.id)?.cloudBackend).toBe("box");
    expect(reloaded.bot(vps.id)?.cloudBackend).toBe("vps");
    expect(reloaded.bot(invalid.id)?.cloudBackend).toBeUndefined();
    expect(reloaded.bot(absent.id)?.cloudBackend).toBeUndefined();

    const saved: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(saved.find((bot) => bot.id === box.id)?.cloudBackend).toBe("box");
    expect(saved.find((bot) => bot.id === vps.id)?.cloudBackend).toBe("vps");
    expect(saved.find((bot) => bot.id === invalid.id)).not.toHaveProperty("cloudBackend");
    expect(saved.find((bot) => bot.id === absent.id)).not.toHaveProperty("cloudBackend");
  });

  it("migrates unambiguous legacy peer grants without guessing duplicate names", () => {
    const store = new Store(selection);
    const requester = store.createBot();
    const helper = store.patchBot(store.createBot().id, { name: "Helper" })!;
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(requester.id, {
      alwaysAllow: ["ask_bot:@Helper", "delegate_bot:@Twin", "Bash:git status"],
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(requester.id)?.alwaysAllow).toEqual([
      peerAllowKey("ask_bot", helper.id),
      "delegate_bot:@Twin",
      "Bash:git status",
    ]);

    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((bot) => bot.id === requester.id)?.alwaysAllow).toEqual(
      reloaded.bot(requester.id)?.alwaysAllow,
    );
  });

  it("persists a bot's effort level across a restart, defaulting to unset", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.modelSelection.effort).toBeUndefined();

    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, effort: "high" } });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.modelSelection.effort).toBe("high");
  });

  it("keeps one persisted Chief of Staff per section and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot({ section: "Work" });
    const second = store.createBot({ section: "Work" });
    const personal = store.createBot({ section: "Personal" });

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);
    expect(store.setChiefOfStaff(personal.id)?.map((bot) => bot.id)).toEqual([personal.id]);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(personal.id)?.chiefOfStaff).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id).sort()).toEqual(
      [second.id, personal.id].sort(),
    );
    expect(reloaded.setChiefOfStaff(null, "Work")?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bot(personal.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(second.id)?.chiefOfStaff).toBe(false);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[0]!;

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });


  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("clearResumeCursors drops the task session and the active-thread mirror", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const background = store.createTask(bot.id, "Detached", false)!;
    store.setResumeCursor(bot.id, "claude", "fat-session", bot.threadId);
    store.setResumeCursor(bot.id, "codex", "bg-thread", background.threadId);

    store.clearResumeCursors(bot.id, bot.threadId);

    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
    expect(store.bot(bot.id)?.resumeCursors).toEqual({});
    expect(store.taskByThread(bot.id, background.threadId)?.resumeCursors).toEqual({ codex: "bg-thread" });

    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
    expect(reloaded.taskByThread(bot.id, background.threadId)?.resumeCursors).toEqual({ codex: "bg-thread" });
  });

  it("markProviderSessionBound records the recycle watermark and drops lastInput", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.addTaskUsage(bot.id, bot.threadId, { input: 88_000, output: 40, costUsd: null });
    store.markProviderSessionBound(bot.id, bot.threadId, "user-recycle-1");
    expect(store.taskByThread(bot.id, bot.threadId)?.providerSessionBoundId).toBe("user-recycle-1");
    expect(store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBeUndefined();
    expect(store.taskByThread(bot.id, bot.threadId)?.usage?.input).toBe(88_000);
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.providerSessionBoundId).toBe("user-recycle-1");
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBeUndefined();
  });

  it("clearResumeCursors is a no-op when the task and mirror are already empty", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    store.clearResumeCursors(bot.id, bot.threadId);

    expect(changes).toEqual([]);
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
  });

  it("owns durable task packets and emits after each write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    const saved = store.writeTaskPacket(taskPacket(bot.id, bot.threadId));
    expect(saved?.goal).toBe("Prepare the weekly report");
    expect(readTaskResumePacket(bot.threadId)).toEqual(saved);
    expect(changes).toContainEqual({ type: "task.packet", threadId: bot.threadId });

    const copy = store.taskPacket(bot.threadId)!;
    copy.goal = "mutated outside the store";
    expect(store.taskPacket(bot.threadId)?.goal).toBe("Prepare the weekly report");
    expect(new Store(selection).taskPacket(bot.threadId)).toEqual(saved);
  });

  it("owns a room task packet through one of its members", () => {
    const store = new Store(selection);
    const member = store.createBot();
    const outsider = store.createBot();
    const room = store.createGroup("Release", [member.id]);

    const saved = store.writeTaskPacket(taskPacket(member.id, room.threadId));

    expect(saved?.threadId).toBe(room.threadId);
    expect(new Store(selection).taskPacket(room.threadId)).toEqual(saved);
    expect(store.writeTaskPacket(taskPacket(outsider.id, room.threadId))).toBeNull();
  });

  it("re-owns a complete room task packet when its owner leaves", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const replacement = store.createBot();
    const room = store.createGroup("Release", [owner.id, replacement.id]);
    const saved = store.writeTaskPacket(taskPacket(owner.id, room.threadId, {
      goal: "Ship the room release",
      plan: [{ step: "Verify the installer", status: "active" }],
      completed: [{ note: "Built the installer", at: 90 }],
      evidence: [{ kind: "file", ref: "reports/green.json", note: "smoke tests passed" }],
      artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
      blockers: [{ kind: "approval", note: "Awaiting release approval" }],
      nextAction: "Verify the installer",
      lastEventId: "event-1",
    }));
    if (!saved) throw new Error("room task packet was not saved");

    store.patchGroup(room.id, { memberIds: [replacement.id] });

    const expected = { ...saved, botId: replacement.id };
    expect(store.taskPacket(room.threadId)).toEqual(expected);
    expect(readTaskResumePacket(room.threadId)).toEqual(expected);
    expect(new Store(selection).taskPacket(room.threadId)).toEqual(expected);
  });

  it("finishes a room membership change when packet re-ownership cannot be written", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const replacement = store.createBot();
    const room = store.createGroup("Release", [owner.id, replacement.id]);
    const saved = store.writeTaskPacket(taskPacket(owner.id, room.threadId));
    if (!saved) throw new Error("room task packet was not saved");
    const events: string[] = [];
    store.onChange((change) => events.push(change.type));
    const write = vi.spyOn(taskState, "writeTaskResumePacket").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    let patched: ReturnType<Store["patchGroup"]> = null;

    try {
      patched = store.patchGroup(room.id, { memberIds: [replacement.id] });
      expect(write).toHaveBeenCalledWith({ ...saved, botId: replacement.id });
      expect(readTaskResumePacket(room.threadId)).toEqual(saved);
    } finally {
      write.mockRestore();
    }

    expect(patched?.memberIds).toEqual([replacement.id]);
    expect(events).toEqual(["group"]);
    const restarted = new Store(selection);
    const expected = { ...saved, botId: replacement.id };
    expect(restarted.group(room.id)?.memberIds).toEqual([replacement.id]);
    expect(restarted.taskPacket(room.threadId)).toEqual(expected);
    expect(readTaskResumePacket(room.threadId)).toEqual(expected);
  });

  it("re-owns a complete room task packet when its owner bot is deleted", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const replacement = store.createBot();
    const room = store.createGroup("Release", [owner.id, replacement.id]);
    const saved = store.writeTaskPacket(taskPacket(owner.id, room.threadId, {
      goal: "Ship the room release",
      plan: [{ step: "Verify the installer", status: "active" }],
      completed: [{ note: "Built the installer", at: 90 }],
      evidence: [{ kind: "file", ref: "reports/green.json", note: "smoke tests passed" }],
      artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
      blockers: [{ kind: "approval", note: "Awaiting release approval" }],
      nextAction: "Verify the installer",
      lastEventId: "event-1",
    }));
    if (!saved) throw new Error("room task packet was not saved");

    store.deleteBot(owner.id);

    const expected = { ...saved, botId: replacement.id };
    expect(store.taskPacket(room.threadId)).toEqual(expected);
    expect(readTaskResumePacket(room.threadId)).toEqual(expected);
    expect(new Store(selection).taskPacket(room.threadId)).toEqual(expected);
  });

  it("finishes bot deletion when packet re-ownership cannot be written", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const replacement = store.createBot();
    const room = store.createGroup("Release", [owner.id, replacement.id]);
    const saved = store.writeTaskPacket(taskPacket(owner.id, room.threadId));
    if (!saved) throw new Error("room task packet was not saved");
    const workspace = workspaceDir(owner.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "MEMORY.md"), "owner memory");
    const events: string[] = [];
    store.onChange((change) => events.push(change.type));
    const write = vi.spyOn(taskState, "writeTaskResumePacket").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    let deleted = false;

    try {
      deleted = store.deleteBot(owner.id);
      expect(write).toHaveBeenCalledWith({ ...saved, botId: replacement.id });
      expect(readTaskResumePacket(room.threadId)).toEqual(saved);
    } finally {
      write.mockRestore();
    }

    expect(deleted).toBe(true);
    expect(store.bot(owner.id)).toBeNull();
    expect(events).toEqual(["thread.deleted", "bot.deleted"]);
    expect(existsSync(workspace)).toBe(false);
    const restarted = new Store(selection);
    const expected = { ...saved, botId: replacement.id };
    expect(restarted.bot(owner.id)).toBeNull();
    expect(restarted.messagesFor(owner.threadId)).toHaveLength(0);
    expect(restarted.taskPacket(room.threadId)).toEqual(expected);
    expect(readTaskResumePacket(room.threadId)).toEqual(expected);
  });

  it("deletes a room task packet when no valid member remains", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const room = store.createGroup("Release", [owner.id]);
    store.writeTaskPacket(taskPacket(owner.id, room.threadId));

    store.deleteBot(owner.id);

    expect(store.taskPacket(room.threadId)).toBeNull();
    expect(readTaskResumePacket(room.threadId)).toBeNull();
  });

  it("rejects a packet whose task does not belong to its bot", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    expect(store.writeTaskPacket(taskPacket("missing-bot", bot.threadId))).toBeNull();
    expect(readTaskResumePacket(bot.threadId)).toBeNull();
  });

  it("deletes a task packet with its transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    store.writeTaskPacket(taskPacket(bot.id, task.threadId));

    expect(store.deleteTask(bot.id, task.threadId)).not.toBeNull();
    expect(readTaskResumePacket(task.threadId)).toBeNull();
    expect(store.taskPacket(task.threadId)).toBeNull();
  });

  it("marks a saved packet when the app recovers a crashed turn", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.writeTaskPacket(taskPacket(bot.id, bot.threadId, { updatedAt: 123 }));
    store.setActivity(bot.id, "working");

    const recovered = new Store(selection);

    expect(recovered.bot(bot.id)?.activity).toBe("idle");
    expect(recovered.taskPacket(bot.threadId)).toMatchObject({
      flushReason: "crash",
      updatedAt: 123,
    });
  });

  it("marks the detached task that was running when the app crashed", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const routineTask = store.createTask(bot.id, "Weekly routine", false)!;
    store.writeTaskPacket(taskPacket(bot.id, bot.threadId));
    store.writeTaskPacket(taskPacket(bot.id, routineTask.threadId));
    store.setActivity(bot.id, "working", routineTask.threadId);

    const recovered = new Store(selection);

    expect(recovered.taskPacket(bot.threadId)?.flushReason).toBe("progress");
    expect(recovered.taskPacket(routineTask.threadId)?.flushReason).toBe("crash");
  });

  it("marks a room packet crash when the speaker died mid-turn there", () => {
    const store = new Store(selection);
    const member = store.createBot();
    const room = store.createGroup("Two bots", [member.id]);
    store.writeTaskPacket(taskPacket(member.id, member.threadId));
    store.writeTaskPacket(taskPacket(member.id, room.threadId, { goal: "Ship the room brief" }));
    store.setActivity(member.id, "working", room.threadId);

    const recovered = new Store(selection);

    expect(recovered.bot(member.id)?.activity).toBe("idle");
    expect(recovered.taskPacket(room.threadId)).toMatchObject({
      flushReason: "crash",
      goal: "Ship the room brief",
    });
    expect(recovered.taskPacket(member.threadId)?.flushReason).toBe("progress");
  });

  it("seeds a room crash packet from the last room instruction when none was saved", () => {
    const store = new Store(selection);
    const member = store.createBot();
    const room = store.createGroup("Two bots", [member.id]);
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "Finish the room brief", at: 1 });
    store.setActivity(member.id, "working", room.threadId);
    const beforeRecover = Date.now();

    const recovered = new Store(selection);
    const packet = recovered.taskPacket(room.threadId);

    expect(recovered.bot(member.id)?.activity).toBe("idle");
    expect(packet).toMatchObject({
      flushReason: "crash",
      botId: member.id,
      threadId: room.threadId,
      goal: "Finish the room brief",
      nextAction: "Finish the room brief",
    });
    expect(packet?.updatedAt).toBeGreaterThanOrEqual(beforeRecover);
    expect(recovered.taskPacket(member.threadId)).toBeNull();
  });

  it("seeds a crash packet from the last user instruction when none was saved", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Finish the weekly brief", at: 1 });
    store.setActivity(bot.id, "working");
    const beforeRecover = Date.now();

    const recovered = new Store(selection);
    const packet = recovered.taskPacket(bot.threadId);

    expect(recovered.bot(bot.id)?.activity).toBe("idle");
    expect(packet).toMatchObject({
      flushReason: "crash",
      botId: bot.id,
      threadId: bot.threadId,
      goal: "Finish the weekly brief",
      nextAction: "Finish the weekly brief",
    });
    expect(packet?.updatedAt).toBeGreaterThanOrEqual(beforeRecover);
  });

  it("markTaskDispatched persists the latest instance and model", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.markTaskDispatched(bot.id, bot.threadId, "codex", "gpt-5.1");
    store.markTaskDispatched(bot.id, bot.threadId, "codex", "gpt-5.2");

    const task = new Store(selection).taskByThread(bot.id, bot.threadId);
    expect(task?.lastInstanceId).toBe("codex");
    expect(task?.lastModel).toBe("gpt-5.2");
  });

  it("seedIfEmpty creates exactly one starter bot, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[0].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });

  it("persists validated redacted compaction state without removing transcript rows", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "first" });
    const recent = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "recent" });
    const secret = `sk-${"z".repeat(32)}`;
    const compacted = store.appendCompaction(bot.threadId, {
      v: 1,
      summary: `Completed work with ${secret}`,
      coveredThroughId: first.id,
      firstKeptId: recent.id,
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 1,
    });

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((message) => message.id)).toEqual([first.id, recent.id, compacted.id]);
    const stored = readContextCompaction({ value: messages.at(-1)?.compaction });
    expect(stored.status).toBe("valid");
    if (stored.status !== "valid") return;
    expect(stored.value.summary).not.toContain(secret);
    expect(stored.value.summary).toContain("redacted");
  });

  it("retains the resume packet, summary, and tail across restart and cursor recovery", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const old = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "old work" });
    const recent = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "recent verification passed" });
    store.appendCompaction(bot.threadId, {
      v: 1,
      summary: "Earlier work produced report.json",
      coveredThroughId: old.id,
      firstKeptId: recent.id,
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 1,
    });
    store.writeTaskPacket(taskPacket(bot.id, bot.threadId, {
      evidence: [{ kind: "file", ref: "report.json" }],
      artifacts: [{ ref: "dist/orbit.exe", label: "installer" }],
      nextAction: "Run the smoke test",
    }));

    const reloaded = new Store(selection);
    const packet = reloaded.taskPacket(bot.threadId);
    const prepared = await prepareModelContext({
      messages: reloaded.activePath(bot.threadId),
      contextWindow: 8_192,
      taskRecordText: "unused",
    });
    expect(packet).not.toBeNull();
    expect(prepared.status).toBe("ready");
    if (!packet || prepared.status !== "ready") return;
    const fallback = buildResumeFallback({ text: "continue", transcript: prepared.transcript, taskRecord: packet });
    expect(fallback).toContain("report.json");
    expect(fallback).toContain("dist/orbit.exe");
    expect(fallback).toContain("recent verification passed");
    expect(fallback).toContain("Next action: Run the smoke test");
  });


  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("deleteBot removes the bot and its durable transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // the transcript is durable — a fresh Store sees the seeded messages
    expect(new Store(selection).messagesFor(bot.threadId).length).toBeGreaterThan(0);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(new Store(selection).messagesFor(bot.threadId)).toHaveLength(0);
    expect(store.deleteBot(bot.id)).toBe(false);
  });
  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    // seedMessages:false — a legacy-era thread has its history ONLY in the
    // JSON file; any DB rows would (correctly) take precedence over it
    const bot = store.createBot({}, { seedMessages: false });
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("Store change stream", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const record = (store: Store) => {
    const events: Array<Record<string, unknown>> = [];
    store.onChange((e) => events.push(e as unknown as Record<string, unknown>));
    return events;
  };

  it("emits once per write, after the write, with the record it wrote", () => {
    const store = new Store(selection);
    // no first-run quiz: a user append is exactly one write
    const bot = store.createBot({ name: "Quiet" }, { seedMessages: false });
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events).toEqual([{ type: "message", threadId: bot.threadId, message: m }]);
    // the emitted record is the stored one (redacted, id'd) — not the input
    expect(store.messagesFor(bot.threadId).at(-1)).toBe(m);
  });

  it("emits a card patch after a user message hides the onboarding quiz", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[0]!;
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events.map((event) => event.type)).toEqual(["message", "message.patch"]);
    expect(events[0]).toEqual({ type: "message", threadId: bot.threadId, message: m });
    expect(events[1]).toMatchObject({
      type: "message.patch",
      threadId: bot.threadId,
      message: { id: quiz.id, card: { dismissed: true } },
    });
  });

  it("announces a new bot before its onboarding messages", () => {
    const store = new Store(selection);
    const events = record(store);
    const bot = store.createBot();
    expect(events.map((event) => event.type)).toEqual(["bot", "message"]);
    expect(events[0]).toEqual({ type: "bot", botId: bot.id });
    expect(events.slice(1).every((event) => event.threadId === bot.threadId)).toBe(true);
  });

  it("every message-tree write emits a message or thread event", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" });
    const events = record(store);
    store.patchMessage(bot.threadId, first.id, { text: "a2" });
    store.branchMessage(bot.threadId, first.id, "b");
    store.setActiveLeaf(bot.threadId, first.id);
    store.toggleReaction(bot.threadId, first.id, "👍", "user");
    expect(events.map((e) => e.type)).toEqual(["message.patch", "message", "thread", "message.patch"]);
    expect(events[2]).toMatchObject({ type: "thread", threadId: bot.threadId, activeLeafId: expect.any(String) });
  });

  it("announces screen frames whose pixels are pruned", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-1" });
    for (let i = 2; i <= 4; i += 1) {
      store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}` });
    }
    const events = record(store);
    const newest = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-5" });
    expect(events).toEqual([
      { type: "message.patch", threadId: bot.threadId, message: { ...first, png: undefined } },
      { type: "message", threadId: bot.threadId, message: newest },
    ]);
  });

  it("every bot write emits a bot event carrying only the id (the wire shape is the caller's)", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const events = record(store);
    store.patchBot(bot.id, { name: "Zed" });
    store.createTask(bot.id, "t2");
    store.switchTask(bot.id, bot.threadId);
    store.renameTask(bot.id, bot.threadId, "renamed");
    store.setResumeCursor(bot.id, "claude", "s1", bot.threadId);
    store.pinTaskCwd(bot.id, bot.threadId, "/private/workspace");
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: null });
    expect(events.every((e) => e.type === "bot" && e.botId === bot.id)).toBe(true);
    expect(events).toHaveLength(7);
    store.deleteBot(bot.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: bot.threadId });
    expect(events.at(-1)).toEqual({ type: "bot.deleted", botId: bot.id });
  });

  it("group writes emit group events; a listener that throws never breaks the write", () => {
    const store = new Store(selection);
    const a = store.createBot();
    const b = store.createBot();
    const events = record(store);
    store.onChange(() => {
      throw new Error("bad listener");
    });
    const g = store.createGroup("ops", [a.id, b.id]);
    store.patchGroup(g.id, { unread: true });
    expect(events.map((e) => e.type)).toEqual(["group", "group"]);
    expect(store.group(g.id)?.unread).toBe(true);
    store.deleteGroup(g.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: g.threadId });
    expect(events.at(-1)).toEqual({ type: "group.deleted", groupId: g.id });
  });

  it("delivers each change to the listener snapshot captured before emission", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    let removeSecond = () => {};
    store.onChange(() => {
      seen.push("first");
      removeSecond();
      store.onChange(() => seen.push("late"));
    });
    removeSecond = store.onChange(() => seen.push("second"));

    store.patchBot(bot.id, { name: "Snapshot" });

    expect(seen).toEqual(["first", "second"]);
  });

  it("unsubscribe stops delivery", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: unknown[] = [];
    const off = store.onChange((e) => seen.push(e));
    off();
    store.patchBot(bot.id, { name: "x" });
    expect(seen).toEqual([]);
  });
});

describe("Store bot activity state", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("derives busy from activity, so every existing busy reader keeps working", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.activity ?? "idle").toBe("idle");
    expect(Boolean(bot.busy)).toBe(false);
    for (const [state, busy] of [
      ["working", true],
      ["waiting-on-you", true],
      ["no-signal", true],
      ["idle", false],
      ["dead", false],
    ] as const) {
      store.setActivity(bot.id, state);
      expect(store.bot(bot.id)?.activity).toBe(state);
      expect(Boolean(store.bot(bot.id)?.busy)).toBe(busy);
    }
  });

  it("emits a bot change per transition and skips a no-op", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    store.onChange((c) => seen.push(c.type));
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "idle");
    expect(seen).toEqual(["bot", "bot"]);
  });

  it("neither activity nor busy survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setActivity(bot.id, "waiting-on-you");
    const again = new Store(selection);
    expect(again.bot(bot.id)?.activity).toBe("idle");
    expect(Boolean(again.bot(bot.id)?.busy)).toBe(false);
  });
});

describe("Store redacts bot-authored secrets on write", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("masks a key in bot text, tools and cards — but never in what the user typed", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Your key is ${key}` });
    expect(reply.text).not.toContain(key);
    expect(reply.text).toContain("«redacted");
    const chip = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `Bash: export TOKEN=${key}`, ok: true, spoken: `running curl Bearer ${key}` } });
    expect(chip.tool?.name).not.toContain(key);
    expect(chip.tool?.spoken).not.toContain(key);
    expect(chip.tool?.spoken).toContain("«redacted");
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Run this?", summary: `curl -H "Authorization: Bearer ${key}"`, held: `Blocked ${key}`, options: [], requestId: "r1", tool: "Bash" } as never,
    });
    expect((card.card as { summary?: string }).summary).not.toContain(key);
    expect(card.card?.held).not.toContain(key);
    const routineCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Confirm routine",
        subtitle: "Every morning",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: {
          version: 1,
          requestId: "routine-request",
          botId: bot.id,
          threadId: bot.threadId,
          createdAt: 1,
          operation: {
            action: "create",
            routine: {
              name: `Use ${key}`,
              instructions: `Send a request with ${key}`,
              schedule: { type: "daily", time: "09:00", weekdays: [1] },
              runOn: "maus",
              durationMinutes: 30,
            },
          },
        },
      },
    });
    expect(routineCard.card?.routineRequest?.operation.action).toBe("create");
    if (routineCard.card?.routineRequest?.operation.action !== "create") throw new Error("missing routine payload");
    expect(routineCard.card.routineRequest.operation.routine.name).not.toContain(key);
    expect(routineCard.card.routineRequest.operation.routine.instructions).not.toContain(key);
    const runCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "routine.run",
      text: `Routine ${key} completed`,
      routineRun: {
        runId: "run-1",
        routineId: "routine-1",
        routineName: `Report ${key}`,
        status: "completed",
        executionThreadId: "execution-1",
        summary: `Finished with ${key}`,
        error: `Ignored ${key}`,
      },
    });
    expect(runCard.routineRun?.routineName).not.toContain(key);
    expect(runCard.routineRun?.summary).not.toContain(key);
    expect(runCard.routineRun?.error).not.toContain(key);
    const secretCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "secret",
      secret: {
        target: "xaiApiKey",
        label: "xAI API key",
        description: `The agent accidentally included ${key}`,
        placeholder: "xai-…",
        helpUrl: "https://console.x.ai/",
        requestKey: "credential-request",
      },
    });
    expect(secretCard.secret?.description).not.toContain(key);
    // the user's own words are theirs
    const mine = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `use ${key} for the api` });
    expect(mine.text).toContain(key);
    // and the stored copy is what was masked, not just the returned one
    const again = new Store(selection);
    expect(again.messagesFor(bot.threadId).find((m) => m.id === reply.id)?.text).not.toContain(key);
  });
});

describe("Store task usage", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("banks each turn's tokens and cost on the task, counting turns", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 100, output: 20, costUsd: 0.01 })).toEqual({
      input: 100,
      output: 20,
      costUsd: 0.01,
      turns: 1,
      lastInput: 100,
    });
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 50, output: 5, costUsd: 0.005 })).toEqual({
      input: 150,
      output: 25,
      costUsd: 0.015,
      turns: 2,
      lastInput: 50,
    });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage).toEqual({
      input: 150,
      output: 25,
      costUsd: 0.015,
      turns: 2,
      lastInput: 50,
    });
  });

  it("keeps cost null until some turn reports one, then sums only reported costs", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBeNull();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: 0.02 })?.costUsd).toBe(0.02);
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBe(0.02);
  });

  it("counts a turn that reported no tokens at all", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { costUsd: null })).toEqual({ input: 0, output: 0, costUsd: null, turns: 1 });
  });

  it("ignores an unknown task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, "nope", { input: 1, output: 1, costUsd: null })).toBeNull();
  });
});

describe("Store task working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the bot's folder onto a task on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the bot's folder
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/tmp/project-a");

    // the bot's folder moves on; this task stays where its session started
    store.patchBot(bot.id, { cwd: "/tmp/project-b" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");

    // a new task starts in the bot's current folder
    const next = store.createTask(bot.id, "second")!;
    expect(store.pinTaskCwd(bot.id, next.threadId)).toBe("/tmp/project-b");
  });

  it("pins the default (null) when the bot has no folder, so a later folder can't move a live session", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
  });

  it("pins a supplied private workspace when the bot has no custom folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId, "/private/bot-workspace")).toBe("/private/bot-workspace");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/private/bot-workspace");
  });

  it("a legacy task that already has a session pins to the default, not the bot's new folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // an older build ran turns here before folders existed
    store.setResumeCursor(bot.id, "claude", "sess-1", bot.threadId);
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("Store remembered project folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("remembers a resolved project per bot without turning it into a pin", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.rememberProjectCwd(bot.id, "/tmp/orbit");
    expect(store.bot(bot.id)?.lastProjectCwd).toBe("/tmp/orbit");
    expect(store.bot(bot.id)?.cwd).toBeUndefined();
    expect(new Store(selection).bot(bot.id)?.lastProjectCwd).toBe("/tmp/orbit");

    store.patchBot(bot.id, { cwd: "/tmp/pinned" });
    expect(store.pinTaskCwd(bot.id, bot.threadId, store.bot(bot.id)?.lastProjectCwd)).toBe("/tmp/pinned");
  });

  it("lets a new unpinned task start in the remembered folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.rememberProjectCwd(bot.id, "/tmp/orbit");
    expect(store.pinTaskCwd(bot.id, bot.threadId, store.bot(bot.id)!.lastProjectCwd)).toBe("/tmp/orbit");
  });

  it("forgets a remembered project without creating a pin", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.rememberProjectCwd(bot.id, "/tmp/orbit");
    store.forgetProjectCwd(bot.id);
    expect(store.bot(bot.id)?.lastProjectCwd).toBeUndefined();
    expect(store.bot(bot.id)?.cwd).toBeUndefined();
    expect(new Store(selection).bot(bot.id)?.lastProjectCwd).toBeUndefined();
  });

  it("Clear of the pin forgets the remembered folder so the next task is private", () => {
    const remembered = mkdtempSync(join(tmpdir(), "omb-remember-"));
    const pinned = mkdtempSync(join(tmpdir(), "omb-pin-"));
    try {
      const store = new Store(selection);
      const bot = store.createBot();
      store.rememberProjectCwd(bot.id, remembered);
      store.patchBot(bot.id, { cwd: pinned });
      store.patchBot(bot.id, { cwd: undefined });

      expect(store.bot(bot.id)?.cwd).toBeUndefined();
      expect(store.bot(bot.id)?.lastProjectCwd).toBeUndefined();

      const resolved = applyResolvedProjectFolder({
        pin: store.bot(bot.id)?.cwd,
        remembered: store.bot(bot.id)?.lastProjectCwd,
        userTexts: ["keep going"],
        remember: (cwd) => store.rememberProjectCwd(bot.id, cwd),
        forget: () => store.forgetProjectCwd(bot.id),
      });
      expect(resolved).toBeUndefined();

      const next = store.createTask(bot.id, "after-clear")!;
      expect(store.pinTaskCwd(bot.id, next.threadId, resolved ?? "/private/bot-workspace")).toBe(
        "/private/bot-workspace",
      );
    } finally {
      rmSync(remembered, { recursive: true, force: true });
      rmSync(pinned, { recursive: true, force: true });
    }
  });

  it("Resume after Clear does not rebuild the remembered folder from chat history", () => {
    const project = mkdtempSync(join(tmpdir(), "omb-project-"));
    try {
      const store = new Store(selection);
      const bot = store.createBot();
      const history = [`work in ${project}`, "keep going"];

      // the chat that named the folder, then Clear
      applyResolvedProjectFolder({
        pin: store.bot(bot.id)?.cwd,
        remembered: store.bot(bot.id)?.lastProjectCwd,
        userTexts: history,
        remember: (cwd) => store.rememberProjectCwd(bot.id, cwd),
        forget: () => store.forgetProjectCwd(bot.id),
      });
      expect(store.bot(bot.id)?.lastProjectCwd).toBe(project);
      store.patchBot(bot.id, { cwd: undefined });
      expect(store.bot(bot.id)?.lastProjectCwd).toBeUndefined();

      // Resume: the synthetic prompt is excluded, but the history is not
      const resumed = applyResolvedProjectFolder({
        pin: store.bot(bot.id)?.cwd,
        remembered: store.bot(bot.id)?.lastProjectCwd,
        continuation: true,
        userTexts: history,
        remember: (cwd) => store.rememberProjectCwd(bot.id, cwd),
        forget: () => store.forgetProjectCwd(bot.id),
      });
      expect(resumed).toBeUndefined();
      expect(store.bot(bot.id)?.lastProjectCwd).toBeUndefined();

      const next = store.createTask(bot.id, "after-resume")!;
      expect(
        store.pinTaskCwd(bot.id, next.threadId, store.bot(bot.id)?.lastProjectCwd ?? "/private/bot-workspace"),
      ).toBe("/private/bot-workspace");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps an explicit pin over a leftover remember after Clear is not used", () => {
    const remembered = mkdtempSync(join(tmpdir(), "omb-remember-"));
    const pinned = mkdtempSync(join(tmpdir(), "omb-pin-"));
    try {
      const store = new Store(selection);
      const bot = store.createBot();
      store.rememberProjectCwd(bot.id, remembered);
      store.patchBot(bot.id, { cwd: pinned });

      const resolved = applyResolvedProjectFolder({
        pin: store.bot(bot.id)?.cwd,
        remembered: store.bot(bot.id)?.lastProjectCwd,
        userTexts: ["keep going"],
        remember: (cwd) => store.rememberProjectCwd(bot.id, cwd),
        forget: () => store.forgetProjectCwd(bot.id),
      });
      expect(resolved).toBe(pinned);
      expect(store.bot(bot.id)?.lastProjectCwd).toBe(remembered);
      expect(store.pinTaskCwd(bot.id, bot.threadId, resolved)).toBe(pinned);
    } finally {
      rmSync(remembered, { recursive: true, force: true });
      rmSync(pinned, { recursive: true, force: true });
    }
  });
});

describe("Store room working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the room's folder on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the room's folder
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");
    expect(store.group(group.id)?.pinnedCwd).toBe("/tmp/project-a");

    // the room's folder moves on; the thread stays where it started working
    store.patchGroup(group.id, { cwd: "/tmp/project-b" });
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");

    // the pin is durable — a restart must not re-pin from the new folder
    const reloaded = new Store(selection);
    expect(reloaded.pinGroupCwd(group.id)).toBe("/tmp/project-a");
  });

  it("pins the default (null) when the room has no folder, so a later folder can't move a running room", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    expect(store.pinGroupCwd(group.id)).toBeNull();
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });
    expect(store.pinGroupCwd(group.id)).toBeNull();
    expect(store.group(group.id)?.pinnedCwd).toBeNull();
  });
});

describe("Store task working folder — cloud runs", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  it("a cloud run pins the default so the bot's host folder never shows for that task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.pinTaskCwd(bot.id, bot.threadId, undefined, { none: true })).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
    // and it stays pinned even if a host run follows
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});
