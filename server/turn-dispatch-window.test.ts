// The window between Stop and the driver actually releasing the thread.
// Boots the real harness server on the fake ACP CLI in `hang` mode — which
// ignores session/cancel, so the driver holds the thread for its full cancel
// grace — stops the turn, and sends again the moment the bot reports idle.
// The send must reach the engine: a bot that says it is ready and then has
// its dispatch refused by its own driver is the defect this pins.
//
// Same POSIX gating as branching.test.ts (the fake CLI is a shebang script).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("dispatch after Stop (fake ACP hang)", () => {
  let child: ChildProcess;
  let home: string;
  let dump: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  /** The fake writes this file when it receives session/prompt — the only
   * proof that a prompt reached the engine rather than dying in the harness. */
  const dumpHas = (text: string) => {
    try {
      return readFileSync(dump, "utf8").includes(text);
    } catch {
      return false; // not written yet
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-dispatch-window-"));
    dump = join(home, "fake-hang-dump.json");
    mkdirSync(join(home, ".orbit"), { recursive: true });
    writeFileSync(
      join(home, ".orbit", "config.json"),
      JSON.stringify({
        instances: {
          hang: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang", FAKE_ACP_DUMP: dump },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
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

  it(
    "dispatches the next message sent the instant the bot reports idle after Stop",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "hang", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
      // Wait for the PROMPT, not just busy: the driver only holds the thread
      // through a cancel once its session exists, and busy is true from
      // turn.started — before that. Stopping earlier kills the process
      // outright and never opens the window this test is about.
      await waitFor(async () => dumpHas("first"), "the first prompt to reach the engine");

      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the stopped bot to report idle");

      // idle means dispatchable. Send with no delay — any wait here would
      // hide the window instead of testing it.
      rmSync(dump, { force: true });
      const send = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
      expect(send.status).toBe(202);
      // Dispatched, not held: the bot reports busy for as long as its driver
      // owns the thread, so reaching this line means the driver has released
      // and the send has no reason to queue. A queue here would mean the
      // harness is holding a message it was free to dispatch.
      expect(send.body.queued).toBeFalsy();
      await waitFor(async () => dumpHas("second"), "the next prompt to reach the engine");

      const bot = await getBot(created.id);
      expect(bot.messages.filter((m: any) => m.text === "second")).toHaveLength(1);
      // no dispatch-failure record: the send either ran or it did not
      expect(bot.messages.map((m: any) => m.tool?.name ?? "")).not.toContain(
        "error: a turn is already running on this thread",
      );

      await api("POST", `/api/bots/${created.id}/interrupt`);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the bot to be released");
    },
    60_000,
  );

  it(
    "holds a send made inside the cancel grace and drains it, rather than erroring",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "hang", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "grace-first" })).status).toBe(202);
      await waitFor(async () => dumpHas("grace-first"), "the first prompt to reach the engine");

      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);

      // Inside the grace on purpose — no wait for idle. Stop has already
      // cleared the store's `busy`, so this is the send that decides
      // queue-vs-dispatch on a flag that no longer describes the driver.
      rmSync(dump, { force: true });
      const send = await api("POST", `/api/bots/${created.id}/messages`, { text: "grace-second" });
      expect(send.status).toBe(202);
      expect(send.body.queued).toBe(true);

      // held, not dropped: the settle drains it the rest of the way
      await waitFor(async () => dumpHas("grace-second"), "the held prompt to drain to the engine");
      const bot = await getBot(created.id);
      expect(bot.messages.filter((m: any) => m.text === "grace-second")).toHaveLength(1);
      expect(bot.messages.map((m: any) => m.tool?.name ?? "")).not.toContain(
        "error: a turn is already running on this thread",
      );

      await api("POST", `/api/bots/${created.id}/interrupt`);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the bot to be released");
    },
    60_000,
  );

  it(
    "will not start a turn on another thread while the driver still owns the stopped one",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "hang", model: "fake-model" },
      });
      const threadA = created.threadId;
      const threadB = (await api("POST", `/api/bots/${created.id}/tasks`)).body.task.threadId;
      expect(threadB).not.toBe(threadA);
      // a new task is activated on creation; the turn under test runs on A
      expect((await api("POST", `/api/bots/${created.id}/tasks/${threadA}`)).status).toBe(200);

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "owner-first" })).status).toBe(202);
      await waitFor(async () => dumpHas("owner-first"), "the first prompt to reach the engine");

      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      // Stop deletes activeThreadId, so nothing on the bot record points at A
      // any more. Switching away and sending is the user-reachable route into
      // the gap — and the store's `busy` is false, so the switch is allowed.
      rmSync(dump, { force: true });
      expect((await api("POST", `/api/bots/${created.id}/tasks/${threadB}`)).status).toBe(200);

      const send = await api("POST", `/api/bots/${created.id}/messages`, { text: "owner-second", threadId: threadB });
      expect(send.status).toBe(202);
      // One provider process per bot: A is still owned, so B waits. Dispatching
      // here would put a second engine on the same bot.
      expect(send.body.queued).toBe(true);
      expect(dumpHas("owner-second")).toBe(false);

      await waitFor(async () => dumpHas("owner-second"), "the held prompt to drain once A settles");
      const bot = await getBot(created.id);
      expect(bot.messages.map((m: any) => m.tool?.name ?? "")).not.toContain(
        "error: a turn is already running on this thread",
      );

      await api("POST", `/api/bots/${created.id}/interrupt`);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the bot to be released");
    },
    60_000,
  );
});
