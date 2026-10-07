// A resumed Claude session or Codex thread keeps the system text it started
// with. These mirror startClaimedTurn's reminder, record and recycle steps
// over the real drivers and their fakes, and read what each turn sent.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "./config.ts";
import { knownCatalogContextWindow } from "./context-compaction.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { Store, type BotRecord } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import {
  buildTurnContext,
  countLastTurnToolRounds,
  countSessionToolRounds,
  sessionPromptFor,
  shouldRecycleProviderSession,
  TurnSeeds,
  turnSeedsSession,
  withSystemChanges,
} from "./turn-context.ts";
import { ensureWorkspace, memorySystemPrompt } from "./workspace.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
const reminder = (...lines: string[]) => [
  "<system-reminder>",
  "[Wink instructions update - your system prompt changed after this session started. Removed lines no longer apply; added lines are current and win over anything older.]",
  ...lines,
  "</system-reminder>",
];
const system = (...memory: string[]) =>
  `You are Testy, a personal bot in Wink. Role: Helper.\n\nYour memory (MEMORY.md):\n${memory.join("\n")}`;

describe("system text on a resumed session", () => {
  let scratch: string;
  let prompts: string;
  let codexDump: string;
  let usageFile: string;
  let instanceId: string;
  let model: string;
  let store: Store;
  let bot: BotRecord;
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let systemSeeds: TurnSeeds<{ instanceId: string; cursor: unknown; system: string }>;

  const start = async (engine: "claude" | "codex" = "claude", engineModel = engine === "claude" ? "claude-opus-5-5" : "gpt-fake-default") => {
    instanceId = engine;
    model = engineModel;
    instance = engine === "claude"
      ? await ClaudeDriver.create({
        instanceId,
        displayName: "Claude",
        environment: {},
        enabled: true,
        config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
      })
      : await CodexDriver.create({ instanceId, displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    systemSeeds = new TurnSeeds();
    instance.adapter.onEvent((event: RuntimeEvent) => {
      if (event.type === "session.started" && event.sessionId) {
        store.setResumeCursor(bot.id, instanceId, event.sessionId, event.threadId);
        const seed = systemSeeds.get(event.threadId);
        if (seed) seed.cursor = event.sessionId;
      } else if (event.type === "turn.completed") {
        const seed = systemSeeds.take(event.threadId, event.turnId);
        if (seed && turnSeedsSession({
          ok: event.ok,
          interrupted: false,
          promptAccepted: event.promptAccepted,
          seed,
          currentCursor: store.taskByThread(bot.id, event.threadId)?.resumeCursors[instanceId],
        })) {
          store.recordSessionSystem(seed.instanceId, seed.cursor, seed.system);
        }
        if (event.prompt) store.recordNativePrompt(bot.id, event.threadId, instanceId, event.prompt, event.contextWindow);
      }
    });
  };

  /** One 1:1 turn the way startClaimedTurn dispatches it, then its tool chips; returns what the engine read. */
  const send = async (text: string, systemText: string, tools = 0) => {
    const task = store.taskByThread(bot.id, bot.threadId)!;
    const sent = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    const messages = store.activePath(bot.threadId);
    const context = (recycleReason?: "session-fat" | "system") => {
      if (recycleReason) {
        store.clearResumeCursors(bot.id, bot.threadId);
        store.markProviderSessionBound(bot.id, bot.threadId, sent.id);
      }
      return buildTurnContext({
        text,
        transcript: [{ role: "user", text: "remember my pet" }],
        rewound: false,
        fresh: false,
        recycled: recycleReason !== undefined,
        recycleReason,
        replaysNatively: false,
      });
    };
    const recycled = shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: countLastTurnToolRounds(messages, new Set([sent.id]), task.providerSessionBoundId),
      sessionToolRounds: countSessionToolRounds(messages, new Set([sent.id]), task.providerSessionBoundId),
      sessionPrompt: sessionPromptFor({
        report: task.nativePrompt,
        cursor: task.resumeCursors[instanceId],
        model,
        catalogWindow: knownCatalogContextWindow(instance.models, model),
      }),
    });
    const { turnText: base, resume } = context(recycled ? "session-fat" : undefined);
    let resumeCursor = resume ? task.resumeCursors[instanceId] : undefined;
    const delivered = resumeCursor === undefined ? undefined : store.sessionSystem(instanceId, resumeCursor);
    let turnText = instance.adapter.capabilities.pinnedSystem === true ? withSystemChanges(base, delivered, systemText) : base;
    if (turnText === null) {
      resumeCursor = undefined;
      turnText = context("system").turnText;
    }
    const seed = systemSeeds.set(bot.threadId, { instanceId, cursor: resumeCursor, system: systemText });
    const { turnId } = await instance.adapter.sendTurn({ threadId: bot.threadId, text: turnText, system: systemText, resumeCursor, model });
    seed.turnId = turnId;
    store.markTaskDispatched(bot.id, bot.threadId, instanceId, model);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    for (let i = 0; i < tools; i++) {
      store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `Read: file-${i}.ts`, ok: true } });
    }
    if (instanceId === "claude") return JSON.parse(readFileSync(prompts, "utf8").trim().split("\n").at(-1) ?? "null");
    const calls: Array<{ method: string; params: { input?: Array<{ text: string }> } }> = JSON.parse(readFileSync(codexDump, "utf8")).calls;
    return { methods: calls.map((call) => call.method), text: calls.find((call) => call.method === "turn/start")?.params.input?.[0]?.text };
  };

  const session = () => store.taskByThread(bot.id, bot.threadId)?.resumeCursors[instanceId];
  /** Writes the bot's MEMORY.md; returns the system text that now carries it. */
  const remember = (...notes: string[]) => {
    writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), `# Memory\n${notes.join("\n")}\n`);
    return `You are Testy, a personal bot in Wink.${memorySystemPrompt(bot.id)}`;
  };
  /** What usage-calls reports from its next turn on. */
  const reportUsage = (first: number, last: number, window: number) => writeFileSync(usageFile, JSON.stringify({ first, last, window }));

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-session-system-"));
    prompts = join(scratch, "prompts.ndjson");
    codexDump = join(scratch, "codex.json");
    usageFile = join(scratch, "usage.json");
    process.env.FAKE_CLAUDE_PROMPT_LOG = prompts;
    process.env.FAKE_CODEX_DUMP = codexDump;
    process.env.FAKE_CLAUDE_USAGE = usageFile;
    store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    bot = store.createBot({}, { seedMessages: false });
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_PROMPT_LOG;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CLAUDE_USAGE;
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MS;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("puts exactly the changed memory lines in the next turn's input", async () => {
    await start();
    const first = await send("hi", system("- Pet: a cat named Mochi", "- City: Seoul"));
    expect(first.text).toBe("hi");

    const second = await send("what pet do I have?", system("- Pet: a dog named Mochi", "- City: Seoul"));
    expect(second.text).toBe(
      [...reminder("[Removed:]", "- Pet: a cat named Mochi", "[Added:]", "- Pet: a dog named Mochi"), "", "what pet do I have?"].join("\n"),
    );
    expect(second.pid).toBe(first.pid);
  });

  it("sends no reminder when nothing changed", async () => {
    await start();
    await send("hi", system("- City: Seoul"));
    expect((await send("and now?", system("- City: Seoul"))).text).toBe("and now?");
  });

  it("does not repeat a delivered change on later turns", async () => {
    await start();
    await send("hi", system("- City: Seoul"));
    expect((await send("moved", system("- City: Busan"))).text).toContain("- City: Busan");
    expect((await send("thanks", system("- City: Busan"))).text).toBe("thanks");
  });

  it("diffs against the delivered text after an idle close and a store reload", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "50";
    await start();
    const first = await send("hi", system("- City: Seoul"));
    await send("moved", system("- City: Busan"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const cold = await send("what city?", system("- City: Busan", "- Job: designer"));
    expect(cold.pid).not.toBe(first.pid);
    expect(cold.argv).toContain("--resume");
    expect(cold.text).toBe([...reminder("[Added:]", "- Job: designer"), "", "what city?"].join("\n"));

    recorder.stop();
    await instance.dispose();
    store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    await start();
    const reloaded = await send("and my job?", system("- City: Busan", "- Job: teacher"));
    expect(reloaded.argv).toContain("--resume");
    expect(reloaded.text).toBe(
      [...reminder("[Removed:]", "- Job: designer", "[Added:]", "- Job: teacher"), "", "and my job?"].join("\n"),
    );
  });

  it("starts a fresh session instead of a reminder past the cap", async () => {
    await start();
    const notes = (word: string) => Array.from({ length: 200 }, (_, i) => `- ${word} note ${i} ${"x".repeat(40)}`);
    const first = await send("hi", system(...notes("old")));
    const firstSession = store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude;

    const recycled = await send("what changed?", system(...notes("new")));
    expect(recycled.pid).not.toBe(first.pid);
    expect(recycled.argv).toContain("--session-id");
    expect(recycled.argv).not.toContain("--resume");
    expect(recycled.systemPrompt).toBe(system(...notes("new")));
    expect(recycled.text).not.toContain("<system-reminder>");
    expect(recycled.text).toContain("because your instructions changed");
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude).not.toBe(firstSession);
  });

  it("sends no reminder on a fresh session's first turn", async () => {
    await start();
    await send("hi", system("- City: Seoul"));
    store.clearResumeCursors(bot.id, bot.threadId);

    const fresh = await send("new session", system("- City: Busan"));
    expect(fresh.argv).toContain("--session-id");
    expect(fresh.systemPrompt).toBe(system("- City: Busan"));
    expect(fresh.text).toBe("new session");
    expect((await send("still there?", system("- City: Busan"))).text).toBe("still there?");
  });

  it("carries the change to a resumed Codex thread", async () => {
    process.env.FAKE_CODEX_MODE = "resume";
    await start("codex");
    expect((await send("hi", system("- City: Seoul"))).text).toBe(`${system("- City: Seoul")}\n\nhi`);

    const second = await send("which city?", system("- City: Busan"));
    expect(second.methods).toContain("thread/resume");
    expect(second.text).toBe(
      [system("- City: Busan"), "", ...reminder("[Removed:]", "- City: Seoul", "[Added:]", "- City: Busan"), "", "which city?"].join("\n"),
    );
  });

  it("tells a tool-heavy session under its prompt budget about a MEMORY.md edit, on the same session", async () => {
    process.env.FAKE_CLAUDE_MODE = "usage-calls";
    await start();
    const first = await send("inspect the tree", remember("- deploy with railway up"), 30);
    const opened = session();
    // 30 tools a turn trips the 24/48 rules; a 46k prompt of a 1M window does not
    for (const text of ["fix the build", "run the tests"]) {
      expect((await send(text, remember("- deploy with railway up"), 30)).text).toBe(text);
    }

    const edited = await send("which package manager?", remember("- deploy with railway up", "- the user prefers pnpm"));
    expect(edited.text).toBe([...reminder("[Added:]", "- the user prefers pnpm"), "", "which package manager?"].join("\n"));
    expect(edited.pid).toBe(first.pid);
    expect(session()).toBe(opened);
    expect(store.taskByThread(bot.id, bot.threadId)?.nativePrompt).toMatchObject({ cursor: opened, first: 45_003, last: 46_202 });
  });

  it("recycles once when the prompt budget and a MEMORY.md edit land on one send", async () => {
    process.env.FAKE_CLAUDE_MODE = "usage-calls";
    await start();
    reportUsage(45_000, 60_000, 1_000_000);
    const first = await send("read the logs", remember("- deploy with railway up"));
    const opened = session();
    reportUsage(150_000, 260_000, 1_000_000);
    await send("dig deeper", remember("- deploy with railway up"));

    const current = remember("- deploy with railway up", "- the user prefers pnpm");
    const recycled = await send("now fix it", current);
    expect(recycled.pid).not.toBe(first.pid);
    expect(recycled.argv).toContain("--session-id");
    expect(recycled.argv).not.toContain("--resume");
    expect(session()).not.toBe(opened);
    expect(recycled.systemPrompt).toBe(current);
    expect(recycled.text.match(/\[Wink started a fresh provider session/g)).toHaveLength(1);
    expect(recycled.text).toContain("to keep tool history bounded");
    expect(recycled.text).not.toContain("<system-reminder>");
  });

  it("starts the loop guard over after a recycle for changed instructions", async () => {
    process.env.FAKE_CLAUDE_MODE = "usage-calls";
    // a 200k window: budget 100k, and a session must grow 50k past its first prompt
    await start("claude", "claude-haiku-4-5");
    const notes = (word: string) => Array.from({ length: 200 }, (_, i) => `- ${word} note ${i} ${"x".repeat(40)}`);
    reportUsage(45_000, 60_000, 200_000);
    await send("hi", system(...notes("old")));

    // the replay alone opens the new session past the budget
    reportUsage(110_000, 112_000, 200_000);
    const recycled = await send("what changed?", system(...notes("new")));
    expect(recycled.argv).not.toContain("--resume");
    expect(recycled.text).toContain("because your instructions changed");
    const reopened = session();
    expect(store.taskByThread(bot.id, bot.threadId)?.nativePrompt).toMatchObject({ cursor: reopened, first: 110_000 });

    const next = await send("carry on", system(...notes("new")));
    expect(next.text).toBe("carry on");
    expect(next.pid).toBe(recycled.pid);
    expect(session()).toBe(reopened);
  });

  it("carries the prompt-size rule and the reminder to a resumed Codex thread", async () => {
    process.env.FAKE_CODEX_MODE = "usage-calls";
    await start("codex");
    await send("hi", system("- City: Seoul"), 30);
    expect(store.taskByThread(bot.id, bot.threadId)?.nativePrompt).toMatchObject({ first: 25_881, last: 29_357 });

    // each turn is a new app-server, and this one accepts thread/resume. 30
    // tools trips the 24/48 rules; 29k of a 258k window does not
    process.env.FAKE_CODEX_MODE = "resume";
    const second = await send("which city?", system("- City: Busan"));
    expect(second.methods).toContain("thread/resume");
    expect(second.text).toBe(
      [system("- City: Busan"), "", ...reminder("[Removed:]", "- City: Seoul", "[Added:]", "- City: Busan"), "", "which city?"].join("\n"),
    );
  });
});
