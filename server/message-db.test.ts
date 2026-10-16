// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  applySyncedRows,
  closeMessageDb,
  deleteThread,
  insertMessage,
  messageDatabase,
  readThread,
  replaceThread,
  scanThreadRows,
  searchHaystack,
  searchMessages,
  setActiveLeaf,
  updateMessage,
  withMessageTransaction,
} from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it.each(["insert", "update", "sync", "replace", "legacy"])("tool detail safety scrubs a %s write before SQLite", (action) => {
    const row = msg("private", "unchanged", { tool: { name: "Edit", detail: { input: "cert.pem", diff: ["+PartialPrivateBody987654321"] } } });
    if (action === "insert") insertMessage("private", row);
    else if (action === "update") {
      insertMessage("private", { ...row, tool: undefined });
      updateMessage("private", row);
    } else if (action === "sync") applySyncedRows("private", [row]);
    else if (action === "replace") replaceThread("private", [row], row.id);
    else {
      writeFileSync(legacy("private"), JSON.stringify([row]));
      readThread("private", legacy("private"));
    }
    expect(JSON.stringify(messageDatabase().prepare("SELECT json FROM messages").all())).not.toContain("PartialPrivateBody");
    expect(readThread("private", legacy("private")).messages[0]).toMatchObject({ text: "unchanged", tool: { detail: { input: "cert.pem", outputHidden: true } } });
  });

  it("tool detail safety scrubs older SQLite rows for reads and scans", () => {
    const row = msg("old", "unchanged", { tool: { name: "Bash", detail: { output: ["Cookie: session=OldBoundaryCanary987654321"] } } });
    messageDatabase().prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("old", row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
    expect(JSON.stringify(readThread("old", legacy("old")))).not.toContain("OldBoundaryCanary");
    expect(JSON.stringify(scanThreadRows("old"))).not.toContain("OldBoundaryCanary");
  });

  it("pages rows without moving an edited row or touching unchanged rows", () => {
    const messages = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
    expect(applySyncedRows("paged", messages, "c")).toBe(4);
    const first = scanThreadRows("paged", 0, 2);
    expect(first.messages.map((row) => row.id)).toEqual(["a", "b"]);
    expect(applySyncedRows("paged", messages, "c")).toBe(0);
    expect(applySyncedRows("paged", [{ ...messages[0], text: "edited" }])).toBe(1);
    const second = scanThreadRows("paged", first.cursor, 2);
    expect(second.messages.map((row) => row.id)).toEqual(["c"]);
    expect(scanThreadRows("paged", second.cursor).messages).toEqual([]);
    expect(scanThreadRows("paged").messages.map((row) => row.text)).toEqual(["edited", "two", "three"]);
  });

  it("rolls row and branch changes back with the outbox transaction", () => {
    applySyncedRows("atomic", [msg("a", "original")], "a");
    expect(() => withMessageTransaction((database) => {
      applySyncedRows("atomic", [msg("a", "edited"), msg("b", "new")], "b", database);
      throw new Error("outbox failed");
    })).toThrow("outbox failed");
    expect(readThread("atomic", legacy("atomic"))).toMatchObject({ messages: [{ id: "a", text: "original" }], activeLeafId: "a" });
  });

  it("rejects unbounded scan pages", () => {
    expect(() => scanThreadRows("t", -1)).toThrow("Invalid thread scan page");
    expect(() => scanThreadRows("t", 0, 1025)).toThrow("Invalid thread scan page");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips a summarized bot message, including a room sender", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const direct = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Checking the logs.",
      summarized: true,
    });
    const room = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Package is ready.",
      summarized: true,
      from: { botId: "scout", name: "Scout", color: "blue" },
    });
    const plain = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "All clear." });

    closeMessageDb();
    const loaded = new Store(selection).messagesFor(bot.threadId);
    expect(loaded.find((message) => message.id === direct.id)).toMatchObject({ summarized: true, text: "Checking the logs." });
    expect(loaded.find((message) => message.id === room.id)).toMatchObject({
      summarized: true,
      text: "Package is ready.",
      from: { name: "Scout" },
    });
    expect(loaded.find((message) => message.id === plain.id)?.summarized).toBeUndefined();
  });

  it("round-trips unknown future compaction versions without deleting them", () => {
    const future = {
      ...msg("future", ""),
      role: "bot" as const,
      kind: "compaction" as const,
      compaction: { v: 99, summary: "newer data", preserve: { all: true } },
    };
    insertMessage("future-thread", future);
    setActiveLeaf("future-thread", future.id);

    closeMessageDb();
    const loaded = readThread("future-thread", legacy("future-thread"));
    expect(loaded.messages).toEqual([future]);
    expect(loaded.activeLeafId).toBe(future.id);
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);

    // Current-chat find scopes in SQL before LIMIT, so busy transcripts in
    // other conversations cannot crowd out this thread's matches.
    expect(searchMessages("railway", 40, "t5").map((hit) => hit.threadId)).toEqual(["t5"]);
    expect(searchMessages("railway", 40, "missing")).toEqual([]);
  });

  it("search never matches a summarized bot note", () => {
    insertMessage("t7", msg("m1", "Checking the deploy logs.", { role: "bot", summarized: true }));
    insertMessage("t7", msg("m2", "The deploy logs are clean.", { role: "bot" }));
    expect(searchMessages("deploy logs").map((hit) => hit.messageId)).toEqual(["m2"]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } } as Message);

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("finds a word that is only in a comm chip's body, in one thread and across threads", () => {
    const comm = { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "pink" };
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");
    insertMessage("t-comm", { ...msg("sent", `${lines}\nCheck the okapi build.`, { role: "bot", kind: "activity", at: 1 }), tool: { name: "Message to @Helper" }, comm: { ...comm, peer: "message" } });
    insertMessage("t-comm", { ...msg("reply", "The quagga run is green.", { role: "bot", kind: "activity", at: 2 }), tool: { name: "Reply from @Helper" }, comm: { ...comm, peer: "reply" } });
    insertMessage("t-plain", { ...msg("plain", "okapi quagga", { role: "bot", kind: "activity", at: 3 }), tool: { name: "Bash", ok: true } });

    const hit = searchMessages("quagga", 40, "t-comm")[0];
    expect(searchMessages("quagga", 40, "t-comm").map((row) => row.messageId)).toEqual(["reply"]);
    expect(hit?.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("quagga");
    expect(searchMessages("okapi").map((row) => row.messageId)).toEqual(["sent"]);
    expect(searchMessages("okapi", 40, "t-comm")[0]?.snippet).toContain("Check the okapi build.");
    expect(searchHaystack({ kind: "activity", tool: { name: "Reply from @Helper" }, comm, text: "quagga" })).toBe("Reply from @Helper\nquagga");
    expect(searchHaystack({ kind: "activity", tool: { name: "Bash", ok: true }, text: "quagga" })).toBe("Bash");
  });

  it("never matches a secret in a comm chip's body", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "Message to @Helper" },
      comm: { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "pink", peer: "message" },
      text: "Use password=abcdefgh!@suffix for staging.",
    });

    expect(searchMessages("staging", 40, bot.threadId)).toHaveLength(1);
    expect(searchMessages("abcdefgh!@suffix", 40, bot.threadId)).toEqual([]);
  });

  it("ranks an older text message ahead of a newer tool-call row", () => {
    insertMessage("t-rank", msg("text-hit", "재판기록의 최세훈입니다", { at: 10 }));
    insertMessage("t-rank", {
      ...msg("tool-hit", "", { at: 50, role: "bot", kind: "activity" }),
      tool: { name: "rg 최세훈 targets-by-id\\1qTq", ok: true },
    });

    const hits = searchMessages("최세훈");
    expect(hits.map((hit) => hit.kind)).toEqual(["text", "activity"]);
    expect(searchMessages("최세훈", 1)[0]?.messageId).toBe("text-hit");
    expect(searchMessages("최세훈", 40, "t-rank").map((hit) => hit.messageId)).toEqual(["tool-hit", "text-hit"]);
  });

  it("counts every copy in a chat hit, newest first", () => {
    insertMessage("t-find", msg("a", "reset, then Reset again", { at: 10 }));
    insertMessage("t-find", msg("b", "one reset", { at: 20 }));
    insertMessage("t-find", msg("c", "a later reset", { at: 20 }));

    const hits = searchMessages("reset", 40, "t-find");
    expect(hits.map((hit) => `${hit.messageId}:${hit.matches}`)).toEqual(["c:1", "b:1", "a:2"]);
  });

  it("pages past a chat hit until every match is reached", () => {
    for (let i = 0; i < 7; i++) insertMessage("t-page", msg(`m${i}`, `reset ${i}`, { at: 100 + Math.floor(i / 2) }));
    const ids: string[] = [];
    let page = searchMessages("reset", 3, "t-page");
    for (let pages = 0; page.length && pages < 5; pages++) {
      ids.push(...page.map((hit) => hit.messageId));
      page = searchMessages("reset", 3, "t-page", { before: ids.at(-1) });
    }
    expect(ids).toEqual(["m6", "m5", "m4", "m3", "m2", "m1", "m0"]);
    expect(searchMessages("reset", 3, "t-page", { before: "missing" })).toEqual([]);
  });

  it("matches only a tool row's name where the skin draws only the name", () => {
    insertMessage("t-chips", {
      ...msg("bash", "", { role: "bot", kind: "activity", at: 1 }),
      tool: { name: "Bash", ok: true, detail: { input: "cat usage.json", output: ['"resets_at": 1'] } },
    });
    insertMessage("t-chips", { ...msg("named", "", { role: "bot", kind: "activity", at: 2 }), tool: { name: "reset_cache", ok: true } });

    expect(searchMessages("reset", 40, "t-chips").map((hit) => hit.messageId)).toEqual(["named", "bash"]);
    expect(searchMessages("reset", 40, "t-chips", { chips: true }).map((hit) => hit.messageId)).toEqual(["named"]);
    expect(searchHaystack({ kind: "activity", tool: { name: "Bash", ok: true, detail: { input: "ls", output: ["reset"] } } }, true)).toBe("Bash");
  });

  it("matches the summary a chip draws, and still skips hidden output", () => {
    insertMessage("t-summary", {
      ...msg("write", "", { role: "bot", kind: "activity", at: 1 }),
      tool: { name: "Write", ok: true, summary: "결과.md" },
    });
    insertMessage("t-summary", {
      ...msg("hidden", "", { role: "bot", kind: "activity", at: 2 }),
      tool: { name: "Bash", ok: true, summary: "ls", detail: { input: "ls", output: ["only-in-output-token"] } },
    });

    for (const chips of [true, false]) {
      expect(searchMessages("결과.md", 40, "t-summary", { chips }).map((hit) => hit.messageId)).toEqual(["write"]);
    }
    expect(searchMessages("only-in-output-token", 40, "t-summary", { chips: true })).toEqual([]);
    expect(searchHaystack({ kind: "activity", tool: { name: "Write", summary: "결과.md" } }, true)).toBe("Write\n결과.md");
  });

  it("finds a failed command result in captured output and skips hidden text", () => {
    const threadId = "t-detail";
    insertMessage(threadId, {
      ...msg("port", "", { role: "bot", kind: "activity", at: 5 }),
      tool: { name: "Bash", ok: false, detail: { input: "npm start", output: ["error EADDRINUSE: address already in use"] } },
    });
    insertMessage(threadId, msg("sum", "engine-summary-token-hidden", { role: "bot", kind: "text", at: 6, summarized: true }));
    insertMessage(threadId, {
      ...msg("secret", "", { role: "bot", kind: "activity", at: 7 }),
      tool: { name: "Bash", ok: true, detail: { input: "echo", output: ["API_KEY=super-secret-value-should-not-leak"] } },
    });

    const hit = searchMessages("EADDRINUSE", 40, threadId)[0];
    expect(hit?.messageId).toBe("port");
    expect(hit?.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("EADDRINUSE");
    expect(searchMessages("npm start", 40, threadId).map((row) => row.messageId)).toEqual(["port"]);
    expect(searchHaystack({ kind: "activity", tool: { name: "Bash", ok: false, detail: { input: "npm start", output: ["error EADDRINUSE: address already in use"] } } })).toContain("EADDRINUSE");
    expect(searchMessages("super-secret-value-should-not-leak", 40, threadId)).toEqual([]);
    expect(searchMessages("engine-summary-token-hidden", 40, threadId)).toEqual([]);
  });

  it("searches only the detail text a terminal row shows", () => {
    const threadId = "t-visible";
    insertMessage(threadId, {
      ...msg("diff", "", { role: "bot", kind: "activity", at: 1 }),
      tool: { name: "Edit", ok: true, detail: { input: "src/visible.ts", diff: ["+visible-diff-token-bbbb"] } },
    });
    insertMessage(threadId, {
      ...msg("faildiff", "", { role: "bot", kind: "activity", at: 2 }),
      tool: { name: "Edit", ok: false, detail: { input: "src/failed.ts", diff: ["+hidden-diff-token-dddd"] } },
    });
    insertMessage(threadId, {
      ...msg("read", "", { role: "bot", kind: "activity", at: 3 }),
      tool: { name: "Read", ok: true, summary: "notes.md", detail: { input: "hidden-path-eeee", output: ["body-line-ffff"] } },
    });
    insertMessage(threadId, {
      ...msg("cut", "", { role: "bot", kind: "activity", at: 4 }),
      tool: { name: "Bash", ok: true, detail: { input: "ls", output: ["keep-one", "keep-two", "keep-three", "cutoff-token-zzzz"] } },
    });
    insertMessage(threadId, {
      ...msg("hidden", "", { role: "bot", kind: "activity", at: 5 }),
      tool: { name: "Bash", ok: true, detail: { input: "printenv", output: ["SECRET-OUTPUT-TOKEN"] } },
    });
    insertMessage(threadId, {
      ...msg("masked", "", { role: "bot", kind: "activity", at: 7 }),
      tool: { name: "Bash", ok: true, detail: { input: "cat notes", outputHidden: true, output: ["masked-output-token-gggg"] } },
    });
    const stale = msg("stale", "", {
      role: "bot",
      kind: "activity",
      at: 6,
      tool: { name: "Bash", ok: true, detail: { output: ["Cookie: session=OldBoundaryCanary987654321"] } },
    });
    messageDatabase().prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      threadId, stale.id, stale.at, stale.role, stale.kind, null, JSON.stringify(stale),
    );

    expect(searchMessages("visible-diff-token-bbbb", 40, threadId).map((hit) => hit.messageId)).toEqual(["diff"]);
    expect(searchMessages("hidden-diff-token-dddd", 40, threadId)).toEqual([]);
    expect(searchMessages("hidden-path-eeee", 40, threadId)).toEqual([]);
    expect(searchMessages("body-line-ffff", 40, threadId).map((hit) => hit.messageId)).toEqual(["read"]);
    expect(searchMessages("keep-one", 40, threadId).map((hit) => hit.messageId)).toEqual(["cut"]);
    expect(searchMessages("cutoff-token-zzzz", 40, threadId)).toEqual([]);
    expect(searchMessages("SECRET-OUTPUT-TOKEN", 40, threadId)).toEqual([]);
    expect(searchMessages("OldBoundaryCanary", 40, threadId)).toEqual([]);
    expect(searchMessages("masked-output-token-gggg", 40, threadId)).toEqual([]);
    expect(searchMessages("+ visible-diff-token-bbbb", 40, threadId).map((hit) => hit.messageId)).toEqual(["diff"]);
    expect(searchMessages("src/visible.ts", 40, threadId).map((hit) => hit.messageId)).toEqual(["diff"]);
    expect(searchMessages("src/failed.ts", 40, threadId).map((hit) => hit.messageId)).toEqual(["faildiff"]);
    expect(searchHaystack({
      kind: "activity",
      tool: { name: "Bash", detail: { input: "printenv", outputHidden: true, output: ["SECRET-SHOULD-NOT-SHOW"] } },
    })).not.toContain("SECRET-SHOULD-NOT-SHOW");
  });

  it("finds Windows paths and quoted text in captured output", () => {
    const threadId = "t-escaped";
    insertMessage(threadId, {
      ...msg("open", "", { role: "bot", kind: "activity", at: 1 }),
      tool: { name: "Bash", ok: false, detail: { input: "tsc", output: ['Cannot open C:\\project\\file.ts or module "alpha"', "got null [code 1]"] } },
    });

    for (const query of ["file.ts", "C:\\project\\file.ts", 'module "alpha"', '"', "null", "[code 1]"]) {
      const hit = searchMessages(query, 40, threadId)[0];
      expect(hit?.messageId).toBe("open");
      expect(hit?.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe(query);
    }
  });

  it("a JSON key in no visible text scans tool rows once and finds nothing", () => {
    for (let at = 1; at <= 5; at++) {
      insertMessage("t-keys", {
        ...msg(`run${at}`, "", { role: "bot", kind: "activity", at }),
        tool: { name: "Bash", ok: true, summary: "npm test", detail: { input: "npm test", output: ["all green"] } },
      });
    }
    // SAFETY: every prepared statement shares the StatementSync prototype.
    const statement = Object.getPrototypeOf(messageDatabase().prepare("SELECT 1")) as StatementSync;
    const all = statement.all;
    const iterate = statement.iterate;
    const get = statement.get;
    const work = { runs: 0, rows: 0 };
    vi.spyOn(statement, "all").mockImplementation(function (this: StatementSync, ...params) {
      work.runs += 1;
      const rows = all.apply(this, params);
      work.rows += rows.length;
      return rows;
    });
    vi.spyOn(statement, "get").mockImplementation(function (this: StatementSync, ...params) {
      work.runs += 1;
      return get.apply(this, params);
    });
    vi.spyOn(statement, "iterate").mockImplementation(function (this: StatementSync, ...params) {
      work.runs += 1;
      const rows = iterate.apply(this, params);
      return (function* (): Generator<Record<string, SQLOutputValue>, undefined> {
        for (const row of rows) {
          work.rows += 1;
          yield row;
        }
      })();
    });

    try {
      for (const key of ["output", "input", "detail"]) {
        expect(searchMessages(key, 1)).toEqual([]);
        expect(searchMessages(key, 1, "t-keys")).toEqual([]);
      }
    } finally {
      vi.restoreAllMocks();
    }
    expect(work).toEqual({ runs: 6, rows: 0 });
    expect(searchMessages("green", 1).map((hit) => hit.messageId)).toEqual(["run5"]);
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });
});
