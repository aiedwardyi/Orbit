// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// These used to be POSIX-only: the fake CLI is a shebang script Windows
// cannot exec, and the broker is a unix socket. Both now go through
// resolveCliSpawn / permissionSocketPath, so they run everywhere.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveImage } from "../attachments.ts";
import { autoVerdict } from "../auto-approve.ts";
import { ensureDirs, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver, claudeToolSummary, claudeUserContent, permissionSocketPath, type ClaudeConfig } from "./claude.ts";
import { inputDigest } from "../repeat-detector.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { REPLY_MARKER } from "../turn-context.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

/** Every credential this process could be holding, plus two nobody has heard
 * of yet — the allowlist has to exclude those for the same reason, under
 * whichever name their provider ships them. */
const FOREIGN_CREDENTIALS = [
  ...PROVIDER_CREDENTIAL_ENV,
  ...WORKSPACE_CREDENTIAL_ENV,
  "ACME_API_KEY",
  "NEWPROVIDER_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

/** Thread ids for the four ask-id-collision tests. Each must truncate to a
 * unique 8-char tag so no two tests share a broker socket/pipe name. */
const COLLISION_THREAD_IDS = ["t-dup-1", "t-dup-2", "t-dup-3", "t-dup-4"];

/** Connect to a broker socket and resolve once the connection is live. */
function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let retriesLeft = 20;
    const tryConnect = () => {
      const conn = connect(path);
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        conn.removeListener("connect", onConnect);
        conn.destroy();
        // A Windows named pipe can briefly disappear while the server creates
        // its next pipe instance for another simultaneous client.
        if (process.platform === "win32" && error.code === "ENOENT" && retriesLeft-- > 0) {
          setTimeout(tryConnect, 25);
          return;
        }
        reject(error);
      };
      conn.once("connect", onConnect);
      conn.once("error", onError);
    };
    tryConnect();
  });
}

/** Returns a function that resolves, in order, with each `\n`-delimited JSON
 * message the broker writes back on `conn` — one call per expected answer. */
function answerQueue(conn: ReturnType<typeof connect>) {
  const waiters: Array<(msg: any) => void> = [];
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      waiters.shift()?.(JSON.parse(line));
    }
  });
  return () => new Promise<any>((resolve) => waiters.push(resolve));
}

describe("claudeToolSummary", () => {
  const cwd = join(tmpdir(), "bot");

  it("names a Read by its path relative to the bot folder, else its basename", () => {
    expect(claudeToolSummary("Read", { file_path: join(cwd, "src", "app.ts") }, cwd)).toBe("src/app.ts");
    expect(claudeToolSummary("Read", { file_path: join(tmpdir(), "elsewhere", "notes.md") }, cwd)).toBe("notes.md");
  });

  it("counts an Edit's added and removed lines without carrying the text", () => {
    const summary = claudeToolSummary(
      "Edit",
      { file_path: join(cwd, "package.json"), old_string: "a\nb\n", new_string: "a\nb\nc\nd" },
      cwd,
    );
    expect(summary).toBe("package.json +4 -2");
  });

  it("clips a Bash command to 60 chars and adds a nonzero exit", () => {
    const command = `echo ${"x".repeat(80)}`;
    expect(claudeToolSummary("Bash", { command }, cwd)).toBe(command.slice(0, 60));
    expect(claudeToolSummary("Bash", { command: "pnpm  lint\n--fix" }, cwd, "Exit code 2\nlint failed")).toBe(
      "pnpm lint --fix · exit 2",
    );
  });

  it("masks a secret in a Bash command", () => {
    expect(claudeToolSummary("Bash", { command: "curl -H 'x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'" }, cwd)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("names a Grep by its pattern, plus the path when given", () => {
    expect(claudeToolSummary("Grep", { pattern: "xterm" }, cwd)).toBe("xterm");
    expect(claudeToolSummary("Grep", { pattern: "xterm", path: cwd }, cwd)).toBe("xterm");
    expect(claudeToolSummary("Grep", { pattern: "xterm", path: join(cwd, "src") }, cwd)).toBe("xterm in src");
  });

  it("caps an unknown tool's first string field at 120 chars", () => {
    const summary = claudeToolSummary("Agent", { description: "y".repeat(200), count: 3 }, cwd);
    expect(summary).toHaveLength(120);
  });
});

describe("claudeUserContent", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]);
  let store: string;
  let outside: string;
  const tag = (path: string) => `<attached-image path="${path}" />`;
  const put = (dir: string, name: string, bytes: Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "omb-claude-store-"));
    outside = mkdtempSync(join(tmpdir(), "omb-claude-outside-"));
  });
  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("adds one native block per store image, in tag order, after the untouched text", () => {
    const jpg = put(store, "b.jpg", JPEG);
    const png = put(store, "a.png", PNG);
    const text = `look\n\n${tag(jpg)}\n\n${tag(png)}`;
    expect(claudeUserContent(text, store)).toEqual([
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    ]);
  });

  it("keeps a turn with no image tags byte-identical to the plain string message", () => {
    const text = 'hi <attached-file path="x.png" /> "quoted" é';
    const msg = (content: ReturnType<typeof claudeUserContent>) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    expect(claudeUserContent(text, store)).toBe(text);
    expect(msg(claudeUserContent(text, store))).toBe(msg(text));
  });

  it("ignores a real image outside the store", () => {
    const text = tag(put(outside, "a.png", PNG));
    expect(claudeUserContent(text, store)).toBe(text);
  });

  it("ignores a text file named .png", () => {
    const text = tag(put(store, "fake.png", Buffer.from("not an image")));
    expect(claudeUserContent(text, store)).toBe(text);
  });

  it("ignores an image over 5 MiB and a missing file", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const text = `${tag(put(store, "big.png", big))}\n${tag(join(store, "gone.png"))}`;
    expect(claudeUserContent(text, store)).toBe(text);
  });

  it("sends the 8 newest native images, dropping the oldest", () => {
    const paths = Array.from({ length: 9 }, (_, i) => put(store, `${i}.png`, Buffer.concat([PNG, Buffer.from([i])])));
    const content = claudeUserContent(paths.map(tag).join("\n"), store);
    if (!Array.isArray(content)) throw new Error("expected blocks");
    expect(content.slice(1).map((b) => (b.type === "image" ? b.source.data : ""))).toEqual(
      paths.slice(1).map((_, i) => Buffer.concat([PNG, Buffer.from([i + 1])]).toString("base64")),
    );
  });

  it("counts a duplicate path once, so it does not push out another image", () => {
    const paths = Array.from({ length: 8 }, (_, i) => put(store, `${i}.png`, Buffer.concat([PNG, Buffer.from([i])])));
    const text = [...paths, paths[7]].map(tag).join("\n");
    const content = claudeUserContent(text, store);
    if (!Array.isArray(content)) throw new Error("expected blocks");
    expect(content.slice(1).map((b) => (b.type === "image" ? b.source.data : ""))).toEqual(
      paths.map((_, i) => Buffer.concat([PNG, Buffer.from([i])]).toString("base64")),
    );
  });

  it("caps total native bytes at 20 MiB, dropping the oldest first", () => {
    const size = 5 * 1024 * 1024;
    const chunk = (marker: number) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length, marker)]);
    const paths = Array.from({ length: 5 }, (_, i) => put(store, `${i}.png`, chunk(i)));
    const content = claudeUserContent(paths.map(tag).join("\n"), store);
    if (!Array.isArray(content)) throw new Error("expected blocks");
    expect(content.slice(1).map((b) => (b.type === "image" ? b.source.data : ""))).toEqual(
      paths.slice(1).map((_, i) => chunk(i + 1).toString("base64")),
    );
  });

  it("unescapes the tag's path attribute", () => {
    const path = put(store, "a&b.png", PNG);
    const content = claudeUserContent(tag(path.replaceAll("&", "&amp;")), store);
    expect(Array.isArray(content) && content.length).toBe(2);
  });

  it("after a replay marker, attaches only the tag past it, not old tags before it", () => {
    const oldPng = put(store, "old.png", PNG);
    const newJpg = put(store, "new.jpg", JPEG);
    const text = `User: look\n${tag(oldPng)}\n\n${REPLY_MARKER}\n\n${tag(newJpg)}`;
    expect(claudeUserContent(text, store)).toEqual([
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
    ]);
  });

  it("after a replay marker with no new tag, stays the plain string even though old tags exist", () => {
    const oldPng = put(store, "old.png", PNG);
    const text = `User: look\n${tag(oldPng)}\n\n${REPLY_MARKER}\n\nno images here`;
    expect(claudeUserContent(text, store)).toBe(text);
  });

  it("with no replay marker, attaches every tag as before", () => {
    const png = put(store, "a.png", PNG);
    const text = tag(png);
    const content = claudeUserContent(text, store);
    expect(Array.isArray(content) && content.length).toBe(2);
  });
});

describe("ClaudeDriver.decodeConfig", () => {
  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("publishes the native Windows installer and npm on macOS/Linux", () => {
    expect(ClaudeDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @anthropic-ai/claude-code",
        linux: "npm install -g @anthropic-ai/claude-code",
        win32: "irm https://claude.ai/install.ps1 | iex",
      },
      docsUrl: "https://claude.com/claude-code",
      signInCommand: "claude",
    });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });

  it("normalizes and deduplicates built-in tool lists", () => {
    expect(
      ClaudeDriver.decodeConfig({
        tools: [" Read ", "WebFetch", "Read"],
        disallowedTools: [" Bash(git *) ", "Bash(git *)"],
      }),
    ).toMatchObject({
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)"],
    });
    expect(ClaudeDriver.decodeConfig({ tools: [] }).tools).toEqual([]);
  });

  it.each([
    ["tools", "Read"],
    ["tools", ["Read", " "]],
    ["disallowedTools", [42]],
  ])("rejects invalid %s configuration", (field, value) => {
    expect(() => ClaudeDriver.decodeConfig({ [field]: value })).toThrow(new RegExp(field));
  });

  it.skipIf(process.platform !== "win32")("names permission pipes per harness process", () => {
    expect(permissionSocketPath("thread-abc")).toMatch(
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\openmausbot-perm-${process.pid}-thre[0-9a-f]{4}$`),
    );
  });

  it("keeps threads whose ids share a prefix on distinct sockets", () => {
    // the truncated prefix agrees; only the digest separates them — without
    // it, Windows pipes for these two threads would collide and race
    expect(permissionSocketPath("t-perm-dup-1")).not.toBe(permissionSocketPath("t-perm-dup-2"));
  });

  it("does not advertise or accept local CUA in bypassPermissions mode", async () => {
    const bypass = await ClaudeDriver.create({
      instanceId: "claude-bypass",
      displayName: "Claude Bypass",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    expect(bypass.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      bypass.adapter.sendTurn({
        threadId: "t-bypass-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive approval broker/);
    await bypass.dispose();
  });

  it("offers the approval chip unless bypassPermissions means nothing ever asks", async () => {
    const make = (permissionMode: "acceptEdits" | "bypassPermissions") =>
      ClaudeDriver.create({
        instanceId: `claude-chip-${permissionMode}`,
        displayName: "Claude",
        environment: {},
        enabled: true,
        config: { cli: FAKE_CLI, permissionMode },
      });
    const [edits, bypass] = await Promise.all([make("acceptEdits"), make("bypassPermissions")]);
    expect(edits.adapter.capabilities.askApproval).toBe(true);
    expect(bypass.adapter.capabilities.askApproval).toBe(false);
    await Promise.all([edits.dispose(), bypass.dispose()]);
  });

  it("gives each collision test a distinct broker pipe path", () => {
    const paths = COLLISION_THREAD_IDS.map(permissionSocketPath);
    expect(new Set(paths).size).toBe(COLLISION_THREAD_IDS.length);
  });
});

describe("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    config: Partial<ClaudeConfig> = {},
  ) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment,
      enabled: true,
      config: {
        ...config,
        cli: config.cli ?? FAKE_CLI,
        permissionMode: config.permissionMode ?? "acceptEdits",
      },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_TRANSIENT_AFTER;
    delete process.env.FAKE_CLAUDE_PARTIAL_FAILS;
    delete process.env.FAKE_CLAUDE_STATE;
    delete process.env.FAKE_CLAUDE_RETRY_SCALE;
    delete process.env.FAKE_CLAUDE_RATE_LIMITS;
    delete process.env.FAKE_CLAUDE_USER_ALLOW;
    delete process.env.FAKE_CLAUDE_TASK_GATE;
    delete process.env.FAKE_CLAUDE_STEER_LOG;
    delete process.env.FAKE_CLAUDE_NARRATION_TEXT;
    delete process.env.FAKE_CLAUDE_PROMPT_LOG;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.META_API_KEY;
    delete process.env.OMB_TTS_KEY;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MS;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS;
    for (const name of FOREIGN_CREDENTIALS) delete process.env[name];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "item.started", // tool tu-1
      "thread.token-usage.updated",
      "item.completed", // tool tu-1 result
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5, cachedInput: 2 }); // input + cache_read, cache_read named
    const done = recorder.events.at(-1)!;
    // usage on the settle is the turn total from the result message, so
    // the harness has one figure to bank per turn
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("forwards the CLI's subscription windows as account.rate-limits.updated", async () => {
    process.env.FAKE_CLAUDE_RATE_LIMITS = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-limits", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(instance.adapter.capabilities.rateLimits).toBe(true);
    // one report per CLI event; the wire's epoch seconds become milliseconds
    expect(recorder.events.filter((e) => e.type === "account.rate-limits.updated")).toMatchObject([
      {
        windows: [
          { id: "five_hour", usedPercent: 12, resetsAt: 1_790_000_000_000, windowMinutes: 300 },
          { id: "seven_day", usedPercent: 76, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 },
        ],
      },
    ]);
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    // two streamed chunks, and NO third full-text fallback delta after them
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    // subagent narration (parent_tool_use_id) never surfaces
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    // reasoning streams on its own kind
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    // the settled message still lands exactly once
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it("settles flagged narration as a summarized reply, never an unlabeled stream", async () => {
    await create("narration");
    await instance.adapter.sendTurn({ threadId: "t-narration", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const replies = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies.map((e: any) => ({ text: e.text, summarized: e.summarized }))).toEqual([
      { text: "Checking the logs now.", summarized: true },
      { text: "plain beside summary", summarized: undefined },
      { text: "the summary line", summarized: true },
      { text: "hello from fake claude", summarized: undefined },
    ]);
    const text = recorder.events.filter((e: any) => e.type === "content.delta" && e.streamKind === "assistant_text");
    expect(text.map((d: any) => d.delta)).toEqual(["plain beside summary", "hello from fake claude"]);
    expect(JSON.stringify(recorder.events)).not.toContain("private reasoning");
    expect(JSON.stringify(recorder.events)).not.toContain("SUBAGENT NARRATION");
  });

  const narrationPart1 = `https://example.com/a/${"a".repeat(478)}`;
  const narrationPart2 = "b".repeat(200);
  const narrationNotice = (summary: string) =>
    `[Wink note, not from the user] Your last message between tool calls was long, so the user saw only this summary of it: "${summary}". If it held anything they need word for word (links, numbers, commands, steps), send just that again now in one short line, or put it in your final reply. Otherwise ignore this note and don't mention it.`;
  const armSteerLog = () => {
    process.env.FAKE_CLAUDE_STEER_LOG = join(scratch, "steers.json");
  };
  const readSteers = () => {
    const parsed = JSON.parse(readFileSync(join(scratch, "steers.json"), "utf8"));
    return Array.isArray(parsed.beforeRequest) ? parsed.beforeRequest : [];
  };

  it("sends one narration notice before the next request when a tool call follows", async () => {
    armSteerLog();
    await create("narration-notice");
    await instance.adapter.sendTurn({ threadId: "t-narration-notice", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const quoted = `${narrationPart1} / ${narrationPart2}`.slice(0, 600);
    expect(readSteers()).toEqual([narrationNotice(quoted)]);
    expect(quoted).toContain("https://example.com/a/");
    expect(quoted.endsWith("b".repeat(97))).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "next request done" }));
    expect(instance.adapter.hasSession("t-narration-notice")).toBe(false);
  });

  it("writes no narration notice when summarized narration has no tool call", async () => {
    armSteerLog();
    await create("narration-only");
    await instance.adapter.sendTurn({ threadId: "t-narration-only", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("Wink note");
    expect(instance.adapter.hasSession("t-narration-only")).toBe(false);
  });

  it("writes no narration notice when the tool call comes in a later response", async () => {
    armSteerLog();
    await create("narration-next-response");
    await instance.adapter.sendTurn({ threadId: "t-narration-next", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("writes no narration notice without narration", async () => {
    armSteerLog();
    await create("narration-plain");
    await instance.adapter.sendTurn({ threadId: "t-narration-plain", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("Wink note");
  });

  it("writes no narration notice for subagent narration", async () => {
    armSteerLog();
    await create("narration-subagent");
    await instance.adapter.sendTurn({ threadId: "t-narration-sub", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("SUBAGENT NARRATION");
    expect(JSON.stringify(recorder.events)).not.toContain("Wink note");
  });

  it("keeps a narration notice out of emitted events", async () => {
    armSteerLog();
    await create("narration-notice");
    await instance.adapter.sendTurn({ threadId: "t-narration-hidden", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()[0]).toContain("Wink note");
    expect(JSON.stringify(recorder.events)).not.toContain("Wink note");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("sends one narration notice per user message", async () => {
    armSteerLog();
    await create("narration-repeat");
    await instance.adapter.sendTurn({ threadId: "t-narration-once", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([narrationNotice("first summary")]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("re-arms the narration notice after a mid-turn message", async () => {
    armSteerLog();
    await create("narration-repeat");
    await instance.adapter.sendTurn({ threadId: "t-narration-rearm", text: "hi" });
    await recorder.until((e) => e.type === "item.completed" && "summarized" in e && e.summarized === true);
    await expect(instance.adapter.steer!("t-narration-rearm", "and the links?")).resolves.toBe(true);
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([narrationNotice("first summary"), "and the links?", narrationNotice("second summary")]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("sends a narration notice as plain text even when it quotes an image tag", async () => {
    armSteerLog();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const summary = `see <attached-image path="${saveImage(png, "image/png").path}" />`;
    process.env.FAKE_CLAUDE_NARRATION_TEXT = summary;
    await create("narration-tag");
    await instance.adapter.sendTurn({ threadId: "t-narration-tag", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(readSteers()).toEqual([narrationNotice(summary)]);
  });

  it("never settles a subagent's final report as a reply", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-subagent-final", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.stringify(recorder.events)).not.toContain("SUBAGENT FINAL");
    const replies = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies.map((e: any) => e.text)).toEqual(["hello from fake claude"]);
  });

  it("opens one continuation for a parent wake, not for a subagent's final", async () => {
    await create("subagent-wake");
    const first = await instance.adapter.sendTurn({ threadId: "t-subagent-wake", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);

    const started = await recorder.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === started.turnId);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    const replies = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toEqual([
      expect.objectContaining({ text: "hello from fake claude", turnId: first.turnId }),
      expect.objectContaining({ text: "research done", turnId: started.turnId }),
    ]);
  });

  it("sends the prompt over stdin, never argv, and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt-file");
    expect(seen.systemPrompt).toBe("You are Testy.");
    expect(seen.argv).toContain("--session-id");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  it("loads an oversized system prompt without putting it on argv", async () => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "large-system.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const system = "Wink rules\n".repeat(4_000) + '한글 "quotes" C:\\Users\\Edward\\memory\n';

    await instance.adapter.sendTurn({ threadId: "t-large-system", text: "hi", system, model: "claude-opus-5-5", effort: "max" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.systemPrompt).toBe(system);
    expect(seen.argv).not.toContain(system);
    expect(seen.argv).not.toContain("--append-system-prompt");
    expect(seen.argv).not.toContain("--mcp-config");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("max");
    const promptPath = seen.argv[seen.argv.indexOf("--append-system-prompt-file") + 1];
    expect(existsSync(dirname(promptPath))).toBe(false);
  });

  it("keeps the warm process when only the system text changes", async () => {
    await create();
    const prompts = join(scratch, "system-reuse.ndjson");
    process.env.FAKE_CLAUDE_PROMPT_LOG = prompts;
    await instance.adapter.sendTurn({ threadId: "t-system-reuse", text: "one", system: "Keep Wink's rules." });
    await recorder.until((e) => e.type === "turn.completed");
    const cursor = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;

    const second = await instance.adapter.sendTurn({ threadId: "t-system-reuse", text: "two", system: "Updated Wink rules.", resumeCursor: cursor });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const seen = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(seen.map((prompt) => prompt.text)).toEqual(["one", "two"]);
    expect(seen[1].pid).toBe(seen[0].pid);
    expect(seen[0].argv).toContain("--append-system-prompt-file");
    expect(seen[0].systemPrompt).toBe("Keep Wink's rules.");
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(existsSync(dirname(seen[0].argv[seen[0].argv.indexOf("--append-system-prompt-file") + 1]))).toBe(false);
  });

  it("sends an attached store image as a native block over stdin", async () => {
    await create();
    const dump = join(scratch, "dump-image.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const text = `what is this\n\n<attached-image path="${saveImage(png, "image/png").path}" />`;

    await instance.adapter.sendTurn({ threadId: "t-image", text });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt.message.content).toEqual([
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    ]);
  });

  it("hands the turn child no credential it was not granted, known or not", async () => {
    await create();
    const dump = join(scratch, "dump-allowlist.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    for (const name of FOREIGN_CREDENTIALS) process.env[name] = `${name}-must-not-leak`;

    await instance.adapter.sendTurn({ threadId: "t-cred-allowlist", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.keys(seen.env).filter((name) => FOREIGN_CREDENTIALS.includes(name))).toEqual([]);
  });

  it("uses instance credentials when launching an injected local model", async () => {
    await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-local-model",
      text: "hi",
      model: "unsloth::local-model",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("local-model");
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
  });

  it("injects a leftover API id when a local host is serving that model", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8888")) {
        return new Response(JSON.stringify({ data: [{ id: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }] }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
      const dump = join(scratch, "dump-leftover.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: "t-leftover-local",
        text: "hi",
        model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF",
      });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("orcarouter/Qwen3.8-27B-Uncensored-GGUF");
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
      expect(seen.env.ANTHROPIC_API_KEY).toBe("unsloth-secret");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("mounts the agents comms proxy as an MCP server and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.agents).toMatchObject({
      args: ["/fake/agents-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok" },
      alwaysLoad: true,
    });
    // the config goes in a private file, never on argv, where `ps` would
    // show the comms token to every other user on the machine
    expect(JSON.stringify(seen.argv)).not.toContain("tok");
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
  });

  it("pre-allows terminal_read but leaves terminal_send to the permission prompt", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-terminal-send",
      text: "hi",
      integrations: { terminal: { command: process.execPath, args: ["/fake/terminal-proxy.js"], env: { OMB_BOT_ID: "b1" } } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const allowed: string[] = seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("mcp__terminal__terminal_read");
    expect(allowed).not.toContain("mcp__terminal");
    expect(seen.mcpConfig.mcpServers.terminal.alwaysLoad).toBe(true);
    expect(allowed).not.toContain("mcp__terminal__terminal_send");
  });

  it("passes normalized available and denied built-in tool sets to Claude", async () => {
    await create(undefined, {}, {
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)", "Edit"],
    });
    const dump = join(scratch, "tool-scope.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-tool-scope", text: "inspect" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("Read,WebFetch");
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toBe("Bash(git *),Edit");
  });

  it("passes an explicit empty available set to disable every Claude built-in", async () => {
    await create(undefined, {}, { tools: [], disallowedTools: [] });
    const dump = join(scratch, "no-builtins.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-builtins", text: "reply only" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).not.toContain("--disallowedTools");
  });

  it("mounts the dweb proxy from the drivers directory and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-dweb",
      text: "hi",
      integrations: { dweb: { url: "http://127.0.0.1:49737" } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.dweb.args[0]).toMatch(/[\\/]drivers[\\/]dweb-proxy\.(?:ts|js)$/);
    expect(seen.mcpConfig.mcpServers.dweb.env.DWEB_URL).toBe("http://127.0.0.1:49737");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__dweb");
  });

  // the harness gates both the integration and the prompt hint on
  // capabilities.composioMcp, so the flag and the mount must agree — a bot
  // told about tools its driver never mounted burns the turn hunting
  it("mounts the user's connected apps and claims the capability that gates them", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.composio).toMatchObject({
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
    });
    expect(seen.mcpConfig.mcpServers.composio.alwaysLoad).toBeUndefined();
    // the user's Composio key must not be readable via `ps`
    expect(JSON.stringify(seen.argv)).not.toContain("ak_test");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__composio");
  });

  // the config file holds live credentials, so it must not outlive the turn —
  // including when the CLI dies mid-turn, which is the path that leaks if
  // cleanup is hung off the happy-path result instead of settle()
  it.each([
    ["a completed turn", "happy"],
    ["a crashed turn", "exit-early"],
  ])("deletes the mcp config file after %s", async (_label, mode) => {
    await create(mode);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-cleanup",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const configPath = (() => {
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      return seen.argv[seen.argv.indexOf("--mcp-config") + 1] as string;
    })();
    expect(configPath).toMatch(/omb-mcp-/);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("mounts local CUA without pre-allowing its computer namespace", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect the desktop",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.computer).toEqual({
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("mcp__computer");
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "sess-123" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
  });

  it.each([
    ["session not found", "resume-fails"],
    ["invalid session across lines", "resume-fails-multiline"],
    ["unknown conversation", "resume-fails-unknown"],
  ])("starts fresh with portable context for %s", async (diagnostic, mode) => {
    await create(mode);
    const dump = join(scratch, "resume-fallback.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    const { turnId } = await instance.adapter.sendTurn({
      threadId: `t-resume-fallback-${diagnostic.replaceAll(" ", "-")}`,
      text: "continue",
      resumeCursor: "missing-session",
      resumeFallback: { text: "durable task record and recent work\n\ncontinue" },
    });
    await recorder.until((event) => event.type === "turn.retrying" && event.reason === "resume_cursor");
    const done = await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--resume");
    expect(seen.prompt.message.content).toBe("durable task record and recent work\n\ncontinue");
    // the relaunch is the same logical turn: the harness records the new
    // session only for the turn id it holds as live
    expect(recorder.events.filter((event) => event.type === "session.started").at(-1)).toMatchObject({ turnId });
    expect(done).toMatchObject({ ok: true, turnId });
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt kills the turn and settles it as failed, not hung", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
  });

  it("releases the thread on interrupt so the next sendTurn is not rejected", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-handoff", text: "one" });
    await recorder.until((e) => e.type === "turn.started");

    await instance.adapter.interruptTurn("t-handoff");
    expect(instance.adapter.hasSession("t-handoff")).toBe(false);

    const second = await instance.adapter.sendTurn({ threadId: "t-handoff", text: "two" });
    expect(second.turnId).toEqual(expect.any(String));
    expect(instance.adapter.hasSession("t-handoff")).toBe(true);

    await instance.adapter.interruptTurn("t-handoff");
    await expect(recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("a message sent mid-turn is steered into the running turn", async () => {
    await create("slow");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "and also this")).resolves.toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const reply = recorder.events.find(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text.startsWith("reply to:"),
    ) as { text: string };
    expect(reply.text).toContain("steered: and also this");
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe(false);
  });

  it("holds the turn open for a steer that missed the final request", async () => {
    await create("late-steer");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-late-steer", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    await expect(instance.adapter.steer!("t-late-steer", "and also this")).resolves.toBe(true);
    const done = await recorder.until((e) => e.type === "turn.completed");
    // settling on the first `result` would free the thread before the CLI
    // answers the steer, and a queued send would race it for the thread
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "reply to: and also this", turnId }),
    );
    expect(done).toMatchObject({ turnId, ok: true, cost: 0.02, usage: { input: 24, output: 10, cachedInput: 4 } });
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(instance.adapter.hasSession("t-late-steer")).toBe(false);
  });

  it("keeps a held result's cost when the follow-up is interrupted", async () => {
    await create("late-steer");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-late-int", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    await expect(instance.adapter.steer!("t-late-int", "and also this")).resolves.toBe(true);
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "reply to: first");
    // the next delta is the CLI answering the steer, after its first `result`
    const seen = recorder.events.filter((e) => e.type === "content.delta").length;
    await recorder.until(() => recorder.events.filter((e) => e.type === "content.delta").length > seen);
    await instance.adapter.interruptTurn("t-late-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: false, stopReason: "exit_before_result", cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } });
  });

  it("reuses the live process for the next compatible turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-live", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    const dumpBefore = readFileSync(dump, "utf8");
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-live", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(readFileSync(dump, "utf8")).toBe(dumpBefore);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("starts a fresh session when a retained process has no matching resume cursor", async () => {
    await create();
    const dump = join(scratch, "recycle-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-recycle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    const firstDump = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; argv: string[] };
    const firstSession = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    expect(firstDump.argv).toContain("--session-id");
    // The CLI must still be idle-retained — that is the Astra hole.
    expect(() => process.kill(firstDump.pid, 0)).not.toThrow();

    // After Orbit compaction the harness clears resumeCursor and injects
    // summary+tail. Reusing the idle CLI would append that onto the fat
    // native history and defeat the bound.
    const second = await instance.adapter.sendTurn({
      threadId: "t-recycle",
      text: "[Orbit compacted this conversation to keep the provider session bounded.]\n\ntwo",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);

    const secondDump = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; argv: string[] };
    expect(secondDump.pid).not.toBe(firstDump.pid);
    expect(secondDump.argv).toContain("--session-id");
    expect(secondDump.argv).not.toContain("--resume");
    expect(secondDump.argv).not.toContain(firstSession);
    const sessions = recorder.events.filter((e) => e.type === "session.started") as Array<{ sessionId: string }>;
    expect(sessions.at(-1)?.sessionId).not.toBe(firstSession);
  });

  it("denies late broker asks between retained turns without opening a zombie card", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retained-late", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");

    const conn = await connectSocket(permissionSocketPath("t-retained-late"));
    const nextAnswer = answerQueue(conn);
    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const answer = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-between", tool: "Bash", input: { command: "echo late" } }) + "\n");

    await expect(answer).resolves.toMatchObject({
      id: "ask-between",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-retained-late", "ask-between", { behavior: "allow" }),
    ).resolves.toBe("unavailable");
    conn.end();
  });

  it("opens a continuation turn when a retained process wakes after result", async () => {
    await create("late-wake");
    const first = await instance.adapter.sendTurn({ threadId: "t-late-wake", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);

    const started = await recorder.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
    expect(instance.adapter.hasSession("t-late-wake")).toBe(true);
    const opened = await recorder.until((e) => e.type === "request.opened" && e.turnId === started.turnId);
    expect(opened).toMatchObject({ tool: "Bash" });
    await expect(
      instance.adapter.respondToRequest("t-late-wake", (opened as { requestId: string }).requestId, { behavior: "allow" }),
    ).resolves.toBe("allowed-once");

    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === started.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "tu-late", ok: true, turnId: started.turnId }),
    );
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "background allow", turnId: started.turnId }),
    );
    expect(instance.adapter.hasSession("t-late-wake")).toBe(false);
  });

  it("steers a send into a continuation turn so it lands before the replies", async () => {
    await create("late-wake");
    const first = await instance.adapter.sendTurn({ threadId: "t-wake-steer", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);

    const started = await recorder.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
    const opened = await recorder.until((e) => e.type === "request.opened" && e.turnId === started.turnId);
    // true is what lets the route record the user message now, not after the drain
    await expect(instance.adapter.steer!("t-wake-steer", "and also this")).resolves.toBe(true);
    const repliesBefore = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text").length;
    await instance.adapter.respondToRequest("t-wake-steer", (opened as { requestId: string }).requestId, { behavior: "allow" });

    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === started.turnId);
    expect(done).toMatchObject({ ok: true });
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies.slice(repliesBefore)).toEqual([
      expect.objectContaining({ text: "background allow + steered: and also this", turnId: started.turnId }),
    ]);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(instance.adapter.hasSession("t-wake-steer")).toBe(false);
  });

  it("rebinds the permission broker when a fresh session replaces a live one", async () => {
    // Rooms omit resumeCursor, so the next spawn re-listens the same pipe.
    // Occupying that name is the Windows EADDRINUSE leftover after teardown.
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-pipe-rebind", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-pipe-rebind");
    await recorder.until((e) => e.type === "turn.completed");

    const occupied = permissionSocketPath("t-pipe-rebind");
    const pipeFree = Date.now() + 8_000;
    while (Date.now() < pipeFree) {
      const free = await new Promise<boolean>((resolve) => {
        const probe = connect(occupied);
        probe.once("connect", () => {
          probe.destroy();
          resolve(false);
        });
        probe.once("error", () => resolve(true));
      });
      if (free) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(occupied, resolve);
    });

    const dump = join(scratch, "rebind.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    try {
      const second = await instance.adapter.sendTurn({ threadId: "t-pipe-rebind", text: "two" });
      await recorder.until((e) => e.type === "session.started" && e.turnId === second.turnId);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const socketPath = seen.mcpConfig.mcpServers.ogb.args[1];
      expect(socketPath).toEqual(expect.any(String));

      const conn = await connectSocket(socketPath);
      conn.write(JSON.stringify({ t: "ask", id: "ask-rebind", tool: "WebSearch", input: { query: "Seoul date" } }) + "\n");
      await expect(recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-rebind")).resolves.toMatchObject({
        tool: "WebSearch",
      });
      await expect(instance.adapter.respondToRequest("t-pipe-rebind", "ask-rebind", { behavior: "allow" })).resolves.toBe(
        "allowed-once",
      );
      conn.end();
      await instance.adapter.interruptTurn("t-pipe-rebind");
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("replaces and resumes a live process when its spawn contract changes", async () => {
    await create();
    const dumpPath = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    await instance.adapter.sendTurn({ threadId: "t-switch", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    rmSync(dumpPath);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "two",
      model: "claude-other",
      resumeCursor: announced,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain("claude-other");
  });

  it("closes an idle session after the configured window", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "50";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-idle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "idle-dump.json");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-idle", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(scratch, "idle-dump.json"), "utf8")).argv).toContain("--resume");
  });

  const exited = async (pid: number) => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };

  it("keeps a session with live background work for the next resumed turn", async () => {
    await create("background-task");
    const dump = join(scratch, "bg-live.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-bg-live", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-bg-live")).toBe(true);

    // a deferred recycle keeps the cursor, so the live process takes the turn
    const { pid } = JSON.parse(readFileSync(dump, "utf8")) as { pid: number };
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-bg-live", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(instance.adapter.hasBackgroundWork!("t-bg-live")).toBe(true);
  });

  it("clears background work on its notification, so the next cursorless turn recycles", async () => {
    const gate = join(scratch, "task-done");
    process.env.FAKE_CLAUDE_TASK_GATE = gate;
    await create("background-task");
    const dump = join(scratch, "bg-done.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-bg-done", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(instance.adapter.hasBackgroundWork!("t-bg-done")).toBe(true);

    writeFileSync(gate, "");
    const woken = await recorder.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === woken.turnId);
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "background task done", turnId: woken.turnId }),
    );
    expect(instance.adapter.hasBackgroundWork!("t-bg-done")).toBe(false);

    const { pid } = JSON.parse(readFileSync(dump, "utf8")) as { pid: number };
    const third = await instance.adapter.sendTurn({ threadId: "t-bg-done", text: "three" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    const after = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; argv: string[] };
    expect(after.pid).not.toBe(pid);
    expect(after.argv).toContain("--session-id");
    expect(await exited(pid)).toBe(true);
  });

  it("re-arms the idle close while background work is live", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "50";
    const gate = join(scratch, "task-done");
    process.env.FAKE_CLAUDE_TASK_GATE = gate;
    await create("background-task");
    const dump = join(scratch, "bg-idle.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-bg-idle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { pid } = JSON.parse(readFileSync(dump, "utf8")) as { pid: number };
    expect(() => process.kill(pid, 0)).not.toThrow();

    writeFileSync(gate, "");
    const woken = await recorder.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === woken.turnId);
    expect(await exited(pid)).toBe(true);
  });

  it("never counts a foreground task as background work", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "50";
    await create("foreground-task");
    const dump = join(scratch, "fg.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-fg", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-fg")).toBe(false);
    expect(await exited((JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid)).toBe(true);
  });

  it("stops counting background work after 2 h without a notification", async () => {
    await create("background-task");
    await instance.adapter.sendTurn({ threadId: "t-bg-stale", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-bg-stale")).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    try {
      expect(instance.adapter.hasBackgroundWork!("t-bg-stale")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  const askBetween = async (threadId: string, ask: Record<string, unknown>) => {
    const conn = await connectSocket(permissionSocketPath(threadId));
    const answer = answerQueue(conn)();
    conn.write(JSON.stringify({ t: "ask", ...ask }) + "\n");
    return { conn, answer };
  };

  it("keeps Auto approvals for a helper an attended Auto turn left running", async () => {
    await create("background-task");
    // the harness's request.opened fold, reduced to the Auto verdict
    const harness = instance.adapter.onEvent((e) => {
      if (e.type !== "request.opened" || !e.requestId) return;
      const verdict = autoVerdict({ autoApprove: true }, e.tool, e.summary);
      void instance.adapter.respondToRequest(e.threadId, e.requestId, { behavior: verdict.approve ? "allow" : "deny" });
    });
    try {
      await instance.adapter.sendTurn({ threadId: "t-helper-auto", text: "one", approval: "auto", attended: true });
      await recorder.until((e) => e.type === "turn.completed");
      expect(instance.adapter.hasBackgroundWork!("t-helper-auto")).toBe(true);

      const { conn, answer } = await askBetween("t-helper-auto", { id: "ask-helper", tool: "Bash", input: { command: "git status" } });
      await expect(answer).resolves.toEqual({ t: "answer", id: "ask-helper", behavior: "allow" });
      expect(recorder.events).toContainEqual(
        expect.objectContaining({ type: "request.opened", requestId: "ask-helper", background: true }),
      );
      expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      conn.end();

      const question = await askBetween("t-helper-auto", { id: "q-helper", kind: "question", tool: "ask_user", input: { question: "which?" } });
      await expect(question.answer).resolves.toMatchObject({
        id: "q-helper",
        behavior: "answer",
        message: "OpenMausBot: the turn is ending — wrap up.",
      });
      question.conn.end();
    } finally {
      harness();
    }
  });

  it("denies a helper's late ask at once when the turn that started it was unattended", async () => {
    await create("background-task");
    await instance.adapter.sendTurn({ threadId: "t-helper-unattended", text: "one", approval: "auto", attended: false });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-helper-unattended")).toBe(true);

    const { conn, answer } = await askBetween("t-helper-unattended", { id: "ask-unattended", tool: "Bash", input: { command: "git status" } });
    await expect(answer).resolves.toMatchObject({
      id: "ask-unattended",
      behavior: "deny",
      message: "OpenMausBot: this needs the user's approval, and the turn that started you has ended. Skip it and say so in your report.",
    });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    conn.end();
  });

  it("approves no helper ask after Stop", async () => {
    await create("background-hang");
    await instance.adapter.sendTurn({ threadId: "t-helper-stop", text: "one", approval: "auto", attended: true });
    await vi.waitFor(() => expect(instance.adapter.hasBackgroundWork!("t-helper-stop")).toBe(true));
    // the proxy's connection outlives Stop; the CLI tree does not
    const conn = await connectSocket(permissionSocketPath("t-helper-stop"));
    const nextAnswer = answerQueue(conn);

    await instance.adapter.interruptTurn("t-helper-stop");
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-helper-stop")).toBe(false);
    const answer = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-stopped", tool: "Bash", input: { command: "git status" } }) + "\n");
    await expect(answer).resolves.toMatchObject({ id: "ask-stopped", behavior: "deny", message: "OpenMausBot: the turn ended" });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    conn.end();
  });

  it("keeps the turn-ended deny for a late ask with no background work", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-helper-none", text: "one", approval: "auto", attended: true });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasBackgroundWork!("t-helper-none")).toBe(false);

    const { conn, answer } = await askBetween("t-helper-none", { id: "ask-none", tool: "Bash", input: { command: "git status" } });
    await expect(answer).resolves.toMatchObject({ id: "ask-none", behavior: "deny", message: "OpenMausBot: the turn ended" });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    conn.end();
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

  it("auto-retries transient exits, then completes with exactly one final message", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "2";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry", text: "go" });

    const done = await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    expect(done).toMatchObject({ turnId });
    expect(recorder.events.filter((e) => e.type === "session.started").at(-1)).toMatchObject({ turnId });
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    // exactly one settled reply across all three launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cap");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("gives a later turn on the same thread a fresh retry budget", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-fresh-budget");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();

    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "one" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2, 1, 2]);
  }, 20_000);

  it("retries the turn a retained process is running, not the one that spawned it", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_TRANSIENT_AFTER = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-warm");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-warm-retry", text: "one" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    expect(firstDone).toMatchObject({ turnId: first.turnId, ok: true });
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;

    // the retained process runs the second turn and dies before a delta;
    // only the relaunch sees the dump path, so it records what was resent
    const dump = join(scratch, "warm-retry-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const second = await instance.adapter.sendTurn({ threadId: "t-warm-retry", text: "two", resumeCursor: announced });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(done).toMatchObject({ turnId: second.turnId, ok: true });
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toEqual([
      expect.objectContaining({ turnId: second.turnId, attempt: 1 }),
    ]);
    // the warm turn's own init, then the relaunch's: all under the second id
    const later = recorder.events.slice(recorder.events.indexOf(firstDone) + 1).filter((e) => e.type === "session.started");
    expect(later.length).toBeGreaterThanOrEqual(2);
    expect(new Set(later.map((e) => e.turnId))).toEqual(new Set([second.turnId]));
    expect(later.at(-1)).toMatchObject({ sessionId: announced });
    const relaunch = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; prompt: { message: { content: string } } };
    expect(relaunch.argv).toContain("--resume");
    expect(relaunch.prompt.message.content).toBe("two");
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(2);
  }, 20_000);

  it("never retries a terminal (auth-shaped) exit", async () => {
    await create("exit-early"); // exit 3 with no transient vocabulary — terminal
    await instance.adapter.sendTurn({ threadId: "t-terminal", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_PARTIAL_FAILS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-partial");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without a zombie relaunch", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cancel");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });

    await recorder.until((e) => e.type === "turn.retrying");
    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    // no second launch ever happened: no further retries, no extra replies
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(0);
  }, 30_000);


  it("skips malformed protocol lines without losing the turn", async () => {
    await create("malformed");
    await instance.adapter.sendTurn({ threadId: "t-noise", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a missing binary surfaces as spawn_error, and snapshot says unavailable", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "spawn_error" });

    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang");
    await instance.adapter.sendTurn({
      threadId: "t-perm-abc",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((e) => e.type === "session.started");

    // connect as the MCP proxy would and raise an ask — unix socket on
    // POSIX, named pipe on Windows, same one the driver handed the proxy
    const conn = connect(permissionSocketPath("t-perm-abc"));
    const answered = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "rm -rf scratch",
      inputDigest: inputDigest({ command: "rm -rf scratch" }),
      requestId: "ask-1",
    });
    // a plain CLI tool never carries the desktop-control approval scope,
    // so the UI can offer a remembered grant for it
    expect(opened).toHaveProperty("approvalScope", undefined);

    // the outcome names exactly what was granted: this action, once
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await answered).toMatchObject({ behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    expect(resolved).toHaveProperty("approvalScope", undefined);

    // a real desktop-control tool keeps the local-computer scope, which
    // suppresses remembered grants — desktop actions must be approved
    // one at a time
    const answered2 = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-2", tool: "mcp__computer__screenshot", input: {} }) + "\n",
    );
    const opened2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.opened");
    expect(opened2).toHaveProperty("approvalScope", "local-computer");
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-2", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await answered2).toMatchObject({ behavior: "allow" });
    const resolved2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.resolved");
    expect(resolved2).toHaveProperty("approvalScope", "local-computer");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("digests every ask field, so one URL with different prompts stays distinct", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-digest", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-digest"));
    const url = "https://example.com/docs";
    const send = (id: string, input: Record<string, unknown>) =>
      conn.write(JSON.stringify({ t: "ask", id, tool: "WebFetch", input }) + "\n");
    send("fetch-a", { url, prompt: "list the endpoints" });
    send("fetch-b", { url, prompt: "summarize auth" });
    send("fetch-c", { prompt: "list the endpoints", url });
    const a = await recorder.until((e) => e.type === "request.opened" && e.requestId === "fetch-a");
    const b = await recorder.until((e) => e.type === "request.opened" && e.requestId === "fetch-b");
    const c = await recorder.until((e) => e.type === "request.opened" && e.requestId === "fetch-c");
    expect(a).toMatchObject({ summary: url });
    expect(b).toMatchObject({ summary: url });
    if (a.type !== "request.opened" || b.type !== "request.opened" || c.type !== "request.opened") throw new Error("missing asks");
    expect(a.inputDigest).not.toBe(b.inputDigest);
    expect(c.inputDigest).toBe(a.inputDigest);

    conn.end();
    await instance.adapter.interruptTurn("t-digest");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("resolves a destructive Bash ask in Auto mode without a user answer", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-auto-destructive", text: "go", approval: "auto" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-auto-destructive"));
    const nextAnswer = answerQueue(conn);
    const command = "rm -rf scratch; cd project && git diff";
    conn.write(JSON.stringify({ t: "ask", id: "ask-destructive", tool: "Bash", input: { command } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-destructive");
    expect(opened).toMatchObject({ requestType: "permission", tool: "Bash", summary: command });
    if (opened.type !== "request.opened") throw new Error("missing permission request");
    expect(autoVerdict({}, opened.tool, opened.summary).approve).toBeNull();
    expect(autoVerdict({ autoApprove: true }, opened.tool, opened.summary).approve).toBe("auto-approved Bash");
    await expect(instance.adapter.respondToRequest(opened.threadId, opened.requestId!, { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });

    conn.end();
    await instance.adapter.interruptTurn("t-auto-destructive");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("holds edits and commands for Allow/Deny in Ask mode, over the user's own allow list", async () => {
    process.env.FAKE_CLAUDE_USER_ALLOW = "Write,Edit,Bash";
    await create("edit");
    const dump = join(scratch, "ask-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-ask-edits", text: "go", cwd: scratch, approval: "ask" });

    const write = await recorder.until((e) => e.type === "request.opened" && e.tool === "Write");
    expect(existsSync(join(scratch, "made.txt"))).toBe(false);
    await expect(instance.adapter.respondToRequest("t-ask-edits", write.requestId!, { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );
    const bash = await recorder.until((e) => e.type === "request.opened" && e.tool === "Bash");
    expect(existsSync(join(scratch, "made.txt"))).toBe(true);
    await instance.adapter.respondToRequest("t-ask-edits", bash.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(existsSync(join(scratch, "ran.txt"))).toBe(false);

    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toMatchObject({
      sandbox: { autoAllowBashIfSandboxed: false },
    });
  });

  it("keeps Auto mode on acceptEdits: edits run unasked, commands reach the broker over the user's allow list", async () => {
    process.env.FAKE_CLAUDE_USER_ALLOW = "Write,Edit,Bash";
    await create("edit");
    const dump = join(scratch, "auto-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-auto-edits", text: "go", cwd: scratch, approval: "auto" });

    const bash = await recorder.until((e) => e.type === "request.opened" && e.tool === "Bash");
    expect(existsSync(join(scratch, "made.txt"))).toBe(true);
    await instance.adapter.respondToRequest("t-auto-edits", bash.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(existsSync(join(scratch, "ran.txt"))).toBe(true);
    expect(recorder.events.some((e) => e.type === "request.opened" && e.tool === "Write")).toBe(false);

    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toEqual({
      permissions: { ask: ["Bash", "PowerShell"] },
      sandbox: { autoAllowBashIfSandboxed: false },
    });
  });

  it("respawns a warm session under the new mode when the chip flips", async () => {
    await create();
    const dump = join(scratch, "flip-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-flip", text: "one", approval: "auto" });
    await recorder.until((e) => e.type === "turn.completed");
    rmSync(dump);
    const started = recorder.events.find((e) => e.type === "session.started");
    const announced = started?.type === "session.started" ? started.sessionId : null;
    const second = await instance.adapter.sendTurn({ threadId: "t-flip", text: "two", resumeCursor: announced, approval: "ask" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    // and a thread with no turn at all is the same answer
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("resolves a pending ask as a system denial when the turn is interrupted", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-stop", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-perm-stop"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-stop");

    await instance.adapter.interruptTurn("t-perm-stop");
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "ask-stop");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
    conn.end();
  });

  it("denies a colliding ask id on the same connection without orphaning the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[0], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[0]));
    const nextAnswer = answerQueue(conn);

    // two asks with the same id on one connection, second sent before the
    // first is resolved
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-1");
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo two" } }) + "\n");

    // the collision is denied immediately, on the wire, with the duplicate's
    // own id and the fixed denial message — and without a second
    // request.opened ever firing for it
    expect(await nextAnswer()).toMatchObject({
      id: "dup-1",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-1")).toHaveLength(1);

    // the original ask is untouched and still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[0], "dup-1", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[0]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id from a second connection on the same broker", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[1], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn1 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    conn1.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-2");

    // `pending` is shared across every connection on the broker, so a
    // second connection reusing the same id must collide too
    const conn2 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    const conn2Answer = answerQueue(conn2)();
    conn2.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo two" } }) + "\n");
    expect(await conn2Answer).toMatchObject({
      id: "dup-2",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-2")).toHaveLength(1);

    // the original, opened on conn1, still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[1], "dup-2", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn1.end();
    conn2.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[1]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("accepts an ask id reused after the original already resolved — not a collision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[2], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[2]));

    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo one");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    // the id is free again once its ask resolved — reusing it is not a
    // collision and should open normally (distinct summary proves this is a
    // fresh request.opened, not the first one already seen by the recorder)
    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo two" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo two");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[2]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id for question-kind asks too, without disturbing the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[3], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[3]));
    const nextAnswer = answerQueue(conn);

    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "one?" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-4");
    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "two?" } }) + "\n");

    // same collision guard applies regardless of ask kind
    expect(await nextAnswer()).toMatchObject({
      id: "dup-4",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-4")).toHaveLength(1);

    // the original question is untouched and still resolves normally
    await expect(
      instance.adapter.respondToRequest(COLLISION_THREAD_IDS[3], "dup-4", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("answered");
    expect(await nextAnswer()).toMatchObject({ behavior: "answer" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[3]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("drops a late ask on an already-closed broker instead of a dead card (#211)", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    // Same connection stays open across the turn ending — the exact
    // condition that let a still-alive child raise an unanswerable card.
    const conn = connect(permissionSocketPath("t-perm-late"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });

    await instance.adapter.interruptTurn("t-perm-late");
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = new Promise<{ id: string; behavior: string; message?: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-late", tool: "Bash", input: { command: "rm -rf /" } }) + "\n");

    // A dead card is a request.opened with no way to ever answer it — assert
    // the late ask never becomes one, and the connection still gets a
    // definite reply rather than hanging forever.
    expect(await reply).toMatchObject({
      id: "ask-late",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(instance.adapter.respondToRequest("t-perm-late", "ask-late", { behavior: "allow" })).resolves.toBe(
      "unavailable",
    );

    conn.end();
  });

  it("drops a late question on an already-closed broker with an answer, not a deny (#211)", async () => {
    // systemEndedReply(kind) branches on "question" vs "permission" — cover
    // the question arm too, since the deny arm above doesn't exercise it.
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-question-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-question-late"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });

    await instance.adapter.interruptTurn("t-question-late");
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = new Promise<{ id: string; behavior: string; message?: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-late", tool: "ask_user", input: { question: "still there?" } }) + "\n");

    expect(await reply).toMatchObject({
      id: "q-late",
      behavior: "answer",
      message: "OpenMausBot: the turn is ending — wrap up.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-question-late", "q-late", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("unavailable");

    conn.end();
  });

  it("passes effort to the CLI, and omits the flag when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--effort");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(seen.argv.filter((a: string) => a === "--effort")).toHaveLength(1);
  });

  it("adds no effort flag when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--effort");
  });

  it("passes --setting-sources project when leanStartup is true", async () => {
    await create();
    const dump = join(scratch, "lean.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-lean", text: "hi", leanStartup: true });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(seen.argv.filter((a: string) => a === "--setting-sources")).toHaveLength(1);
    expect(seen.argv).not.toContain("--bare");
  });

  it("adds no setting-sources flag when leanStartup is off", async () => {
    await create();
    const dump = join(scratch, "lean-off.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-lean-off", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--setting-sources");
    expect(seen.argv).not.toContain("--bare");
  });

  it("strips workspace credentials from generateText helper children", async () => {
    const instanceConfigDir = join(scratch, "instance-claude-config");
    await create(undefined, { CLAUDE_CONFIG_DIR: instanceConfigDir });
    const dump = join(scratch, "generate-text-env.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "META_API_KEY", "OMB_TTS_KEY"] as const;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;

    await instance.generateText?.("summarize safely");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toBe("summarize safely");
    expect(seen.argv).not.toContain("summarize safely");
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(instanceConfigDir);
    for (const name of names) expect(seen.env[name]).toBeUndefined();
  });

  it("declares safe same-provider permission review", async () => {
    await create();
    await expect(instance.reviewPermission?.("review this request")).resolves.toBe("fake generated text");
  });

  it("stops permission review when its caller gives up", async () => {
    await create();
    const controller = new AbortController();
    controller.abort();
    await expect(instance.reviewPermission?.("review this request", controller.signal)).rejects.toThrow(/aborted/);
  });

  it("declares the effort levels the CLI accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

// Auth state must come from the CLI, not from probing its credential store:
// on macOS the OAuth tokens live in the login Keychain, so the old
// ~/.claude/.credentials.json check reported signed-in users as signed out
// and disabled the model picker with them (#108).
describe("ClaudeDriver snapshot auth (fake CLI)", () => {
  let instance: ProviderInstance;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-auth-test",
      displayName: "Claude Auth Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.ANTHROPIC_API_KEY;
    await instance?.dispose();
  });

  it("reports authenticated when `auth status` says loggedIn", async () => {
    process.env.FAKE_CLAUDE_AUTH = "in";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("reports signed out when `auth status` says loggedIn:false", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("keeps unavailable auth status neutral and refreshes after sign-in", async () => {
    await create();

    process.env.FAKE_CLAUDE_AUTH = "unsupported";
    expect(await instance.snapshot({ rescan: true })).toMatchObject({ state: "available", authenticated: undefined });

    process.env.FAKE_CLAUDE_AUTH = "malformed";
    expect(await instance.snapshot({ rescan: true })).toMatchObject({ state: "available", authenticated: undefined });

    // The real turn removes inherited API keys, so the auth probe must do the
    // same or setup can report a login the turn cannot use.
    process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    expect(await instance.snapshot({ rescan: true })).toMatchObject({ state: "available", authenticated: false });
  });
});
