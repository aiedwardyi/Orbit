// Historical bot secrets must not leave the HTTP boundary. New writes are
// already scrubbed; this seeds a pre-redaction transcript and checks that
// hydration, pagination, and both export formats project a safe view while
// leaving the stored row intact.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOT_ID = "hist-bot";
const THREAD_ID = "hist-thread";
const GROUP_ID = "hist-room";
const GROUP_THREAD_ID = "hist-room-thread";
const SECRET = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
const HUMAN_SECRET = `sk-ant-api03-${"HUMANPASTEDKEY0123456789abcdef"}`;
const PEM_LINE = "AbCd0123+/".repeat(10);
const PEM_BODY = Array(8).fill(PEM_LINE).join("\n");
const PEM_MARKER = `«redacted ${PEM_BODY.length} chars»`;

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";

const api = async (method: string, path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "omb-export-proj-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );
  writeFileSync(
    join(home, ".orbit", "bots.json"),
    JSON.stringify([
      {
        id: BOT_ID,
        threadId: THREAD_ID,
        name: "Historian",
        title: "",
        description: "",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "ghost", model: "none" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: THREAD_ID, title: "New task", createdAt: 1, resumeCursors: {} }],
      },
    ]),
  );
  writeFileSync(
    join(home, ".orbit", "groups.json"),
    JSON.stringify([
      {
        id: GROUP_ID,
        threadId: GROUP_THREAD_ID,
        name: "Secret room",
        memberIds: [BOT_ID],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
      },
    ]),
  );
  writeFileSync(
    join(home, ".orbit", `messages-${THREAD_ID}.json`),
    JSON.stringify({
      activeLeafId: "bot-pem",
      messages: [
        {
          id: "bot-secret",
          at: 1,
          parentId: null,
          role: "bot",
          kind: "text",
          text: `here is the key ${SECRET}`,
        },
        {
          id: "human-paste",
          at: 2,
          parentId: "bot-secret",
          role: "user",
          kind: "text",
          text: `i typed ${HUMAN_SECRET} on purpose`,
        },
        {
          id: "bot-pem",
          at: 3,
          parentId: "human-paste",
          role: "bot",
          kind: "text",
          // Write-time redaction already stored the original body length.
          text: `pem follows\n-----BEGIN PRIVATE KEY-----\n${PEM_MARKER}\n-----END PRIVATE KEY-----`,
        },
      ],
    }),
  );
  writeFileSync(
    join(home, ".orbit", `messages-${GROUP_THREAD_ID}.json`),
    JSON.stringify({
      activeLeafId: "room-secret",
      messages: [
        {
          id: "room-secret",
          at: 1,
          parentId: null,
          role: "bot",
          kind: "text",
          text: `room nearby ${SECRET}`,
          from: { botId: BOT_ID, name: "Historian", color: "blue" },
        },
      ],
    }),
  );

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
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

describe("historical transcript export projection", () => {
  it("redacts a stored bot secret from hydration, pagination, and both export formats", async () => {
    const json = await api("GET", `/api/threads/${THREAD_ID}/export?format=json`);
    expect(json.status).toBe(200);
    const jsonText = JSON.stringify(json.body);
    expect(jsonText).not.toContain(SECRET);
    expect(jsonText).toContain("«redacted");
    expect(jsonText).toContain(HUMAN_SECRET);

    const markdown = await fetch(`http://127.0.0.1:${port}/api/threads/${THREAD_ID}/export`);
    expect(markdown.status).toBe(200);
    const md = await markdown.text();
    expect(md).not.toContain(SECRET);
    expect(md).toContain("«redacted");
    expect(md).toContain(HUMAN_SECRET);

    const hydrate = await api("GET", "/api/bots");
    expect(hydrate.status).toBe(200);
    const hydrateText = JSON.stringify(hydrate.body);
    expect(hydrateText).not.toContain(SECRET);
    expect(hydrateText).toContain("«redacted");
    expect(hydrateText).toContain(HUMAN_SECRET);

    const page = await api("GET", `/api/threads/${THREAD_ID}/messages?limit=10`);
    expect(page.status).toBe(200);
    const pageText = JSON.stringify(page.body);
    expect(pageText).not.toContain(SECRET);
    expect(pageText).toContain("«redacted");
    expect(pageText).toContain(HUMAN_SECRET);

    const db = new DatabaseSync(join(home, ".orbit", "messages.db"), { readOnly: true });
    try {
      const row = z.object({ json: z.string() }).parse(
        db.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?").get(THREAD_ID, "bot-secret"),
      );
      expect(row.json).toContain(SECRET);
    } finally {
      db.close();
    }
  });

  it("redacts a stored bot secret from search snippets and keeps match offsets", async () => {
    const result = await api("GET", `/api/search?q=${encodeURIComponent("here is the key")}`);
    expect(result.status).toBe(200);
    const hit = result.body.hits.find((candidate: { messageId: string }) => candidate.messageId === "bot-secret");
    expect(hit).toBeTruthy();
    expect(hit.snippet).not.toContain(SECRET);
    expect(hit.snippet).toContain("«redacted");
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe("here is the key");
  });

  it("keeps the original PEM body length through hydration, pagination, and both exports", async () => {
    const hydrate = await api("GET", "/api/bots");
    expect(hydrate.status).toBe(200);
    const hydrateText = JSON.stringify(hydrate.body);
    expect(hydrateText).toContain(PEM_MARKER);
    expect(hydrateText).not.toContain(PEM_LINE);

    const page = await api("GET", `/api/threads/${THREAD_ID}/messages?limit=10`);
    expect(page.status).toBe(200);
    const pageText = JSON.stringify(page.body);
    expect(pageText).toContain(PEM_MARKER);
    expect(pageText).not.toContain(PEM_LINE);

    const json = await api("GET", `/api/threads/${THREAD_ID}/export?format=json`);
    expect(json.status).toBe(200);
    const jsonText = JSON.stringify(json.body);
    expect(jsonText).toContain(PEM_MARKER);
    expect(jsonText).not.toContain(PEM_LINE);

    const markdown = await fetch(`http://127.0.0.1:${port}/api/threads/${THREAD_ID}/export`);
    expect(markdown.status).toBe(200);
    const md = await markdown.text();
    expect(md).toContain(PEM_MARKER);
    expect(md).not.toContain(PEM_LINE);
  });

  it("redacts a stored bot secret from group hydration", async () => {
    const hydrate = await api("GET", "/api/bots");
    expect(hydrate.status).toBe(200);
    const group = hydrate.body.groups.find((candidate: { id: string }) => candidate.id === GROUP_ID);
    expect(group).toBeTruthy();
    const groupText = JSON.stringify(group.messages);
    expect(groupText).not.toContain(SECRET);
    expect(groupText).toContain("«redacted");
    expect(groupText).toContain("room nearby");
  });
});
