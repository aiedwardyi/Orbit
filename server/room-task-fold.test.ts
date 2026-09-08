// The automatic task-state fold on a ROOM turn. Boots the real harness on
// the fake claude CLI in happy mode — which plays one tool call and one
// reply — sends a room message mentioning the only member, and reads the
// room's durable packet back off disk.
//
// The real claudeAgent driver is used deliberately: its hasSession reports
// live thread ownership, unlike the in-memory fake driver's constant false.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 31800 + Math.floor(Math.random() * 6_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const packet = (threadId: string) => z.object({
  botId: z.string(),
  completed: z.array(z.object({ note: z.string(), at: z.number() })),
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().optional() })),
  flushReason: z.string(),
}).passthrough().parse(JSON.parse(
  readFileSync(join(home, ".orbit", "task-state", `${threadId}.json`), "utf8"),
));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-fold-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({
      instances: {
        claudeHappy: {
          driver: "claudeAgent",
          displayName: "Fixture Claude Happy",
          environment: { FAKE_CLAUDE_MODE: "happy" },
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("room task-state fold", () => {
  it("folds a room turn's tool evidence and completion onto the room packet", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const models = z.object({ default: z.string() }).parse(
      (await api("GET", "/api/instances")).body.instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "claudeHappy",
      ).models,
    );
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claudeHappy", model: models.default },
    })).status).toBe(200);

    const group = (await api("POST", "/api/groups", {
      name: "Fold room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const sent = await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} run the check` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);

    // the room itself shows finished work: the member's reply is on the wall
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { text?: string }[];
      return messages.some((message) => message.text?.includes("hello from fake claude"));
    }, { timeout: 20_000 }).toBe(true);

    const folded = packet(group.threadId);
    expect(folded.botId).toBe(bot.id);
    expect(folded.flushReason).toBe("turn-end");
    expect(folded.completed.at(-1)?.note).toContain("hello from fake claude");
    expect(folded.evidence.some((item) => item.kind === "tool" && item.note === "Bash")).toBe(true);

    // consecutive turns on the same room thread each fold, so the record
    // tracks the room rather than settling once and going stale
    const again = await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} check once more` });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    await expect.poll(
      () => packet(group.threadId).completed.length,
      { timeout: 20_000 },
    ).toBe(2);
  }, 60_000);
});
