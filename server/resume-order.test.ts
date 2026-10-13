import { describe, expect, it, vi } from "vitest";

import { listedRuns, workerRuns } from "../src/lib/worker-runs.ts";
import { callTool } from "./drivers/terminal-proxy.ts";
import { commitLaunchNote } from "./launch-note.ts";
import { requestCredentials } from "./phone-auth.ts";
import { Store } from "./store.ts";
import { terminalResumeResponse } from "./terminal-resume.ts";

const PANE = "5d09c0d0-2844-43b0-982e-88305df70570";
const LABEL = "A | Opus 5.5 | high";
const ACCESS = { url: "http://bridge.invalid", token: "test" };

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot({ name: "Wink" });
  const report = (text = "DONE A branch=x sha=y dirty=no") => store.appendMessage(bot.threadId, {
    role: "bot", kind: "note",
    text: `[pane ${PANE.slice(0, 8)}] [${LABEL}] from Wink (${bot.id}): ${text}`,
  });
  store.appendMessage(bot.threadId, {
    role: "bot", kind: "launch",
    text: `Launched ${LABEL}\nLabel: ${LABEL}\nWorking folder: C:\\repo\nSession: ${PANE}`,
  });
  report();
  const snapshot = {
    sessionId: PANE, generation: 2, screenText: "echo ok", label: LABEL, cwd: "C:\\repo",
    panes: [{ sessionId: "main", generation: 1, main: true }, { sessionId: PANE, generation: 2, label: LABEL, main: false }],
  };
  const stateNow = () => listedRuns(workerRuns(store.activePath(bot.threadId)).map((run) => ({ run, state: run.state })), new Set([PANE]))[0]?.state;
  const resumes = () => store.activePath(bot.threadId).filter((message) => message.text?.startsWith("Resumed "));
  const commit = (fetchImpl: typeof fetch, resumed = true, submittedAgo?: number) => commitLaunchNote({
    access: ACCESS,
    botId: bot.id,
    threadId: bot.threadId,
    activePath: (threadId) => store.activePath(threadId),
    appendMessage: (threadId, text) => store.appendMessage(threadId, { role: "bot", kind: "launch", text }),
    submittedAgo,
  }, PANE, resumed, fetchImpl);
  return { store, bot, report, snapshot, stateNow, resumes, commit };
}

describe("terminal_send resume ordering", () => {
  it("stays done when the follow-up reports while the launch note is reading the pane", async () => {
    const f = fixture();
    let note: Promise<unknown> = Promise.resolve();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!String(url).endsWith("/launch-note")) return Response.json(f.snapshot);
      expect(String(init?.body)).toContain("\"resumed\":true");
      note = f.commit(async () => {
        f.report("DONE A branch=x sha=z dirty=no");
        return Response.json(f.snapshot);
      }, true);
      return Response.json(await note);
    };
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const result = callTool("terminal_send", fetchImpl, {
        host: "http://bridge.invalid", token: "test", botId: f.bot.id, harness: "http://harness.invalid", commsToken: "test",
      }, { text: "echo ok\n", sessionId: PANE, generation: 2 });
      await vi.runAllTimersAsync();
      expect((await result).isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(await note).toEqual({ skipped: true });
    expect(f.resumes()).toEqual([]);
    expect(f.stateNow()).toBe("done");
  });

  it("shows working when the report is already in before terminal_send", async () => {
    const f = fixture();
    let note: Promise<unknown> = Promise.resolve();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!String(url).endsWith("/launch-note")) return Response.json(f.snapshot);
      expect(String(init?.body)).toContain("\"resumed\":true");
      note = f.commit(async () => Response.json(f.snapshot), true);
      return Response.json(await note);
    };
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const result = callTool("terminal_send", fetchImpl, {
        host: "http://bridge.invalid", token: "test", botId: f.bot.id, harness: "http://harness.invalid", commsToken: "test",
      }, { text: "echo ok\n", sessionId: PANE, generation: 2 });
      await vi.runAllTimersAsync();
      expect((await result).isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(await note).toMatchObject({ messageId: expect.any(String) });
    expect(f.resumes()).toHaveLength(1);
    expect(f.resumes()[0]?.text).toMatch(/Submitted: \d+/);
    expect(f.stateNow()).toBe("working");
  });

  // The bridge answers the Enter write 50 ms late; the worker may report meanwhile.
  async function lateEnter(f: ReturnType<typeof fixture>, reports: boolean) {
    let note: Promise<unknown> = Promise.resolve();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/launch-note")) {
        note = f.commit(async () => Response.json(f.snapshot), true, JSON.parse(String(init?.body)).submittedAgo);
        return Response.json(await note);
      }
      if (init?.method === "POST" && JSON.parse(String(init.body)).text === "\r") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (reports) f.report("DONE A branch=x sha=z dirty=no");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return Response.json(f.snapshot);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const result = callTool("terminal_send", fetchImpl, {
        host: "http://bridge.invalid", token: "test", botId: f.bot.id, harness: "http://harness.invalid", commsToken: "test",
      }, { text: "echo ok\n", sessionId: PANE, generation: 2 });
      await vi.runAllTimersAsync();
      expect((await result).isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    return note;
  }

  it("stays done when the follow-up reports during the Enter write", async () => {
    const f = fixture();
    expect(await lateEnter(f, true)).toEqual({ skipped: true });
    expect(f.resumes()).toEqual([]);
    expect(f.stateNow()).toBe("done");
  });

  it("shows working through a slow Enter write when the follow-up has not reported", async () => {
    const f = fixture();
    expect(await lateEnter(f, false)).toMatchObject({ messageId: expect.any(String) });
    expect(f.resumes()).toHaveLength(1);
    expect(f.stateNow()).toBe("working");
  });
});

describe("typed resume ordering", () => {
  it("stays done when the follow-up reports while the snapshot is in flight", async () => {
    const f = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      f.report("DONE A branch=x sha=z dirty=no");
      return Response.json(f.snapshot);
    });
    const context = { store: f.store, access: ACCESS, credentials: requestCredentials(false, false, true, undefined) };
    expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE }, fetchImpl)).toEqual({ status: 200, body: { resumed: false } });
    expect(f.resumes()).toEqual([]);
    expect(f.stateNow()).toBe("done");
  });

  it("shows working when the report is already in before the typed line", async () => {
    const f = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(f.snapshot));
    const context = { store: f.store, access: ACCESS, credentials: requestCredentials(false, false, true, undefined) };
    expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE }, fetchImpl)).toMatchObject({ status: 201, body: { resumed: true } });
    expect(f.resumes()[0]?.text).toMatch(/Submitted: \d+/);
    expect(f.stateNow()).toBe("working");
  });

  it("stays done when the follow-up reports before a resume request with no row id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      const f = fixture();
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(f.snapshot));
      const context = { store: f.store, access: ACCESS, credentials: requestCredentials(false, false, true, undefined) };
      vi.setSystemTime(2_025);
      f.report("DONE A branch=x sha=z dirty=no");
      vi.setSystemTime(2_050);
      expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE, submittedAgo: 50 }, fetchImpl)).toEqual({ status: 200, body: { resumed: false } });
      expect(f.resumes()).toEqual([]);
      expect(f.stateNow()).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows working at the submit time when a resume request with no row id beats the report", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      const f = fixture();
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(f.snapshot));
      const context = { store: f.store, access: ACCESS, credentials: requestCredentials(false, false, true, undefined) };
      vi.setSystemTime(2_050);
      expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE, submittedAgo: 50 }, fetchImpl)).toMatchObject({ status: 201, body: { resumed: true } });
      expect(f.resumes()[0]?.text).toMatch(/Submitted: 2000$/);
      expect(f.stateNow()).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });
});
