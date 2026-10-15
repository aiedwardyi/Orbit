import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptFacts,
  appendNotes,
  createMemoryPass,
  eligibleRow,
  noteSummary,
  parseFacts,
  secretLike,
  userTyping,
  type MemoryPass,
  type NoteGenerator,
} from "./memory-pass.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import type { Message, StoreChange } from "./store.ts";
import { MEMORY_SEED, memoryFileRaw, writeMemoryFile } from "./workspace.ts";

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 15, 12).getTime();

const row = (patch: Partial<Message> = {}): Message => ({ id: "m", at: 1, role: "user", kind: "text", text: "hi", ...patch });

function fakeStore() {
  const threads = new Map<string, Message[]>();
  const listeners = new Set<(change: StoreChange) => void>();
  let seq = 0;
  const emit = (change: StoreChange) => {
    for (const listener of listeners) listener(change);
  };
  return {
    onChange(listener: (change: StoreChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    // SAFETY: the pass only tests a room for presence.
    groupByThread: (threadId: string) => (threadId.startsWith("room") ? ({ id: "g" } as never) : undefined),
    // SAFETY: the pass only reads the bot id.
    botByThread: (threadId: string) => (threadId.startsWith("room") ? null : ({ id: `bot-${threadId}` } as never)),
    appendMessage(threadId: string, message: Omit<Message, "id" | "at">, imported?: true) {
      const full: Message = { id: `m${++seq}`, at: Date.now(), ...message };
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      emit(imported ? { type: "message", threadId, message: full, imported } : { type: "message", threadId, message: full });
      return full;
    },
    rows: (threadId: string) => threads.get(threadId) ?? [],
  };
}

const facts = (...items: Array<[string, string]>) => JSON.stringify(items.map(([fact, quote]) => ({ fact, quote })));

describe("memory pass", () => {
  let store: ReturnType<typeof fakeStore>;
  let dataDir: string;
  let busy: Set<string>;
  let generate: ReturnType<typeof vi.fn<NoteGenerator>>;
  let generator: NoteGenerator | null;
  let pass: MemoryPass;
  const passes: MemoryPass[] = [];

  const start = () => {
    const created = createMemoryPass({ store, dataDir, generate: () => generator, busy: (botId) => busy.has(botId) });
    passes.push(created);
    return created;
  };
  const say = (threadId: string, text: string, patch: Partial<Message> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, ...patch });
  const settle = async (threadId: string, wait = 0) => {
    pass.onSettled(`bot-${threadId}`, threadId);
    if (wait) await vi.advanceTimersByTimeAsync(wait);
    await pass.idle();
  };
  const chips = (threadId: string) => store.rows(threadId).filter((m) => m.tool?.name === MEMORY_SAVE_TOOL);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, "info").mockImplementation(() => {});
    store = fakeStore();
    dataDir = mkdtempSync(join(tmpdir(), "memory-pass-"));
    busy = new Set();
    generate = vi.fn<NoteGenerator>(async () => "[]");
    generator = generate;
    writeMemoryFile("bot-t1", "");
    pass = start();
  });

  afterEach(() => {
    for (const created of passes.splice(0)) created.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs once the thread has been idle 3 minutes after a turn", async () => {
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE - 1);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i'm 38");
  });

  it("runs right at the turn end after 8 new user messages", async () => {
    for (let i = 0; i < 8; i += 1) say("t1", `line ${i}`);
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a new user message holds the idle timer until the next turn ends", async () => {
    say("t1", "first");
    pass.onSettled("bot-t1", "t1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    say("t1", "second");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does nothing without user text since the last pass", async () => {
    await settle("t1", 3 * MINUTE);
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps the watermark across a restart", async () => {
    say("t1", "i can't read korean");
    await vi.advanceTimersByTimeAsync(1_000);
    pass.dispose();
    pass = start();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i can't read korean");
    pass.dispose();
    pass = start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dataDir, "memory-pass.json"), "utf8"))).toEqual({ threads: {} });
  });

  it("skips while the bot is busy and retries at the next idle", async () => {
    say("t1", "i'm 38");
    busy.add("bot-t1");
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    busy.delete("bot-t1");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("runs one pass per bot and two app-wide", async () => {
    const release: Array<() => void> = [];
    generator = vi.fn<NoteGenerator>(() => new Promise((resolve) => release.push(() => resolve("[]"))));
    for (const threadId of ["a", "b", "c"]) {
      for (let i = 0; i < 8; i += 1) say(threadId, `x ${i}`);
      pass.onSettled(threadId === "c" ? "bot-a" : `bot-${threadId}`, threadId);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledTimes(2);
    release.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledTimes(3);
    for (const done of release.splice(0)) done();
    await pass.idle();
  });

  it("never takes notes from rows imported by thread sync", async () => {
    store.appendMessage("t1", { role: "user", kind: "text", text: "i'm 38" }, true);
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("ignores room threads", async () => {
    for (let i = 0; i < 8; i += 1) say("room1", `x ${i}`);
    await settle("room1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("sends only the user's own typing", async () => {
    say("t1", "i'm 38\n\n<pasted-text index=\"1\">\nmy coworker is 52\n</pasted-text>");
    say("t1", "from a bot", { from: { botId: "b", name: "B", color: "#fff" } });
    say("t1", "routine prompt", { origin: "routine" });
    say("t1", "draft", { queued: true });
    store.appendMessage("t1", { role: "user", kind: "secret", text: "hunter2" });
    await settle("t1", 3 * MINUTE);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain("i'm 38");
    for (const text of ["coworker", "from a bot", "routine prompt", "draft", "hunter2"]) expect(prompt).not.toContain(text);
  });

  it("saves grounded facts as dated lines with one chip per pass", async () => {
    writeMemoryFile("bot-t1", "# Memory\n- Prefers pnpm\n");
    generate.mockResolvedValue(
      facts(["38 years old", "i'm 38"], ["Can't read Korean", "I can't read Korean"], ["Hates drama", "hate high school drama"], ["Likes cats", "i love cats"]),
    );
    say("t1", "i'm 38 and I can't read Korean");
    say("t1", "i hate high school drama");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(
      "# Memory\n- Prefers pnpm\n- 38 years old (noted 2026-10-15)\n- Can't read Korean (noted 2026-10-15)\n- Hates drama (noted 2026-10-15)\n",
    );
    expect(chips("t1")).toHaveLength(1);
    expect(chips("t1")[0]!.tool).toEqual({ name: MEMORY_SAVE_TOOL, ok: true, spoken: "38 years old, Can't read Korean, Hates drama" });
  });

  it("starts an empty file from the seed", async () => {
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- 38 years old (noted 2026-10-15)\n`);
  });

  it("drops the batch on a revision conflict and retries at the next pass", async () => {
    writeMemoryFile("bot-t1", "# Memory\n");
    generate.mockImplementationOnce(async () => {
      writeMemoryFile("bot-t1", "# Memory\n- edited meanwhile\n");
      return facts(["38 years old", "i'm 38"]);
    });
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n- edited meanwhile\n");
    expect(chips("t1")).toHaveLength(0);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n- edited meanwhile\n- 38 years old (noted 2026-10-15)\n");
    expect(chips("t1")).toHaveLength(1);
  });

  it("skips an append that would pass the memory budget", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"], ["Can't read Korean", "can't read korean"]));
    say("t1", "i'm 38, can't read korean");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(full);
    expect(chips("t1")).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("too-large"));
  });

  it("holds a batch that lands while the bot is busy", async () => {
    generate.mockImplementationOnce(async () => {
      busy.add("bot-t1");
      return facts(["38 years old", "i'm 38"]);
    });
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(0);
    busy.delete("bot-t1");
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(1);
  });

  it("skips quietly when Claude is missing or signed out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockRejectedValue(new Error("Not logged in - Please run /login"));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    say("t1", "i can't read korean");
    await settle("t1", 3 * MINUTE);
    generator = null;
    await settle("t1", 3 * MINUTE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.rows("t1").every((m) => m.role === "user")).toBe(true);
  });
});

describe("memory pass filters", () => {
  it("accepts only typed user text rows", () => {
    expect(eligibleRow(row())).toBe(true);
    for (const patch of [
      { role: "bot" as const },
      { kind: "secret" as const },
      { from: { botId: "b", name: "B", color: "#fff" } },
      { origin: "webhook" },
      { comm: { groupId: "g", withBotId: "b", withName: "B", withColor: "#fff" } },
      { queued: true },
      { image: "a.png" },
      { hasImage: true },
    ]) expect(eligibleRow(row(patch))).toBe(false);
  });

  it("cuts pastes, attachments, code, quotes and long blocks", () => {
    const text = [
      "i'm 38",
      '<pasted-text index="1">\npasted body\n</pasted-text>',
      "<pasted_content>wrapped paste</pasted_content>",
      '<attached-file path="C:/a.pdf" name="a.pdf" size="3" />',
      "```\nconst code = 1;\n```",
      "> quoted reply",
      `he said "${"q".repeat(90)}" ok`,
      "x".repeat(401),
      "1\n2\n3\n4\n5\n6\n7",
    ].join("\n\n");
    expect(userTyping(text)).toBe("i'm 38\n\nhe said  ok");
  });

  it("masks secrets before text leaves Wink", () => {
    expect(userTyping("my key is sk-ant-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop");
  });

  it("rejects facts without a verbatim quote", () => {
    const text = "i'm 38 and live in Seoul";
    expect(acceptFacts([{ fact: "38 years old", quote: "I'm 38" }], text, "")).toEqual(["38 years old"]);
    expect(acceptFacts([{ fact: "Lives in Korea", quote: "lives in Korea" }], text, "")).toEqual([]);
    expect(acceptFacts([{ fact: "Is 39", quote: "" }], text, "")).toEqual([]);
    expect(acceptFacts([{ fact: "x", quote: "y".repeat(121) }], "y".repeat(121), "")).toEqual([]);
  });

  it("rejects secret-looking facts", () => {
    for (const fact of [
      "Wifi password is Tr0ub4dor",
      "PIN is 4471",
      "Uses token sk-ant-abc123def456",
      "GitHub ghp_abcdefghij1234567890",
      "Has eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      "Code a8Fj29dkLq03mZp7XyT5vB2n",
    ]) expect(secretLike(fact)).toBe(true);
    expect(secretLike("Uses Muse Spark 1.3")).toBe(false);
    const text = "my wifi password is Tr0ub4dor";
    expect(acceptFacts([{ fact: "Has wifi at home", quote: "my wifi password is Tr0ub4dor" }], text, "")).toEqual([]);
  });

  it("dedupes against MEMORY.md and within the batch", () => {
    const text = "i can't read korean. i'm 38";
    const notes = "# Memory\n- Can't read Korean; translate for dad\n";
    expect(acceptFacts([{ fact: "Unable to read Korean", quote: "i can't read korean" }], text, notes)).toEqual([]);
    expect(acceptFacts([{ fact: "38", quote: "i'm 38" }, { fact: "38", quote: "38" }], text, notes)).toEqual(["38"]);
  });

  it("parses the model's JSON reply", () => {
    expect(parseFacts('```json\n[{"fact":"a","quote":"b"}]\n```')).toEqual([{ fact: "a", quote: "b" }]);
    expect(parseFacts("nothing")).toEqual([]);
    expect(parseFacts('[{"fact":1}]')).toEqual([]);
  });

  it("appends within the budget only", () => {
    expect(appendNotes("# M", ["a"], NOW)).toBe("# M\n- a (noted 2026-10-15)\n");
    expect(appendNotes(`# M\n${"x".repeat(23_990)}\n`, ["a"], NOW)).toBeNull();
  });

  it("keeps the chip summary short", () => {
    expect(noteSummary(["a", "b"])).toBe("a, b");
    expect(noteSummary(["x".repeat(200)])).toHaveLength(120);
  });
});

describe("memory pass wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(here, "index.ts"), "utf8");

  it("runs every bot's pass on Claude, after 1:1 turns, without a session transcript", () => {
    expect(index).toMatch(/createMemoryPass\(\{[\s\S]*?driverKind === "claude"[\s\S]*?ephemeral: true[\s\S]*?botHasActiveTurn/);
    expect(index).toMatch(/summaryRepair\.onSettled\(bot\.id, event\.threadId\);\s*memoryPass\.onSettled\(bot\.id, event\.threadId\);/);
    expect(index).toContain("memoryPass.dispose();");
  });
});
