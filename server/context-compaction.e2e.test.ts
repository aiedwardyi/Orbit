import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CODEX_CLI = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const BOT_ID = "compaction-bot";
const THREAD_ID = "compaction-thread";
const CLAUDE_BOT_ID = "compaction-claude-bot";
const CLAUDE_THREAD_ID = "compaction-claude-thread";

interface ApiBody {
  text: string;
}

describe("context compaction e2e", () => {
  let child: ChildProcess;
  let home: string;
  let dumpPath: string;
  let claudeDumpPath: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  const waitFor = async (predicate: () => Promise<boolean>, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for server state. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CODEX_CLI, 0o755);
    chmodSync(FAKE_CLAUDE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "orbit-compaction-e2e-"));
    dumpPath = join(home, "codex-dump.json");
    claudeDumpPath = join(home, "claude-dump.json");
    const dataDir = join(home, ".orbit");
    mkdirSync(join(dataDir, "task-state"), { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        codex: {
          driver: "codex",
          environment: { FAKE_CODEX_DUMP: dumpPath },
          config: { cli: FAKE_CODEX_CLI },
        },
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_DUMP: claudeDumpPath,
            FAKE_CLAUDE_GENERATE_DELAY_MS: "1500",
          },
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }));
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
      {
        id: BOT_ID,
        threadId: THREAD_ID,
        name: "Continuity",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: CLAUDE_BOT_ID,
        threadId: CLAUDE_THREAD_ID,
        name: "Summary",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: CLAUDE_THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
    ]));
    const messages = Array.from({ length: 97 }, (_, index) => ({
      id: `m${index}`,
      at: index + 1,
      parentId: index ? `m${index - 1}` : null,
      role: index % 2 === 0 ? "user" : "bot",
      kind: "text",
      text: `history ${index}`,
    }));
    for (const [threadId, botId] of [[THREAD_ID, BOT_ID], [CLAUDE_THREAD_ID, CLAUDE_BOT_ID]]) {
      writeFileSync(join(dataDir, `messages-${threadId}.json`), JSON.stringify({
        activeLeafId: "m96",
        messages,
      }));
      writeFileSync(join(dataDir, "task-state", `${threadId}.json`), JSON.stringify({
        v: 1,
        threadId,
        botId,
        goal: "Ship the release",
        plan: [{ step: "Run smoke tests", status: "active" }],
        completed: [{ note: "Built the installer", at: 1 }],
        evidence: [{ kind: "file", ref: "reports/green.json" }],
        artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
        blockers: [],
        nextAction: "Run smoke tests",
        updatedAt: 1,
        updatedBy: "harness",
        flushReason: "progress",
        turnsAtWrite: 0,
      }));
    }

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        return false;
      }
    });
    await waitFor(async () => {
      const instances = (await api("GET", "/api/instances")).body.instances;
      return ["codex", "claude"].every((instanceId) =>
        instances.find((instance: { instanceId: string }) => instance.instanceId === instanceId)?.snapshot.state === "available",
      );
    });
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("dispatches a long thread through a driver without generateText", async () => {
    const sent = await api("POST", `/api/bots/${BOT_ID}/messages`, { text: "Continue with final QA" });
    expect(sent.status).toBe(202);

    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === BOT_ID,
      );
      return bot?.busy;
    }, { timeout: 10_000 }).toBe(false);

    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const turn = dump.calls.find((call: { method: string }) => call.method === "turn/start");
    const prompt = turn.params.input[0].text;
    expect(prompt).toContain("Goal: Ship the release");
    expect(prompt).toContain("reports/green.json");
    expect(prompt).toContain("dist/orbit.exe");
    expect(prompt).toContain("history 0");
    expect(prompt).toContain("history 96");

    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === BOT_ID,
    );
    expect(bot.messages.filter((message: { kind: string }) => message.kind === "compaction")).toHaveLength(1);
    expect(bot.messages.some((message: { text?: string }) => message.text === "history 0")).toBe(true);
    expect(JSON.stringify(bot.messages)).not.toContain("cannot summarize it");
  }, 30_000);

  it("rejects another turn while generated compaction is preparing", async () => {
    const first = api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start final QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const second = await api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start packaging too" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already working");
    await expect(first).resolves.toMatchObject({ status: 202 });

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
      );
      return bot?.busy === false;
    });
    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
    );
    expect(bot.messages.filter((message: { text?: string }) => message.text === "Start final QA")).toHaveLength(1);
    expect(bot.messages.some((message: { text?: string }) => message.text === "Start packaging too")).toBe(false);
  }, 30_000);
});
