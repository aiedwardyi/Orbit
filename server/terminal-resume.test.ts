import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { listedRuns, workerRuns } from "../src/lib/worker-runs.ts";
import { relayVerdict, requestCredentials } from "./phone-auth.ts";
import { buildRemoteSetCookie } from "./remote-access.ts";
import { Store } from "./store.ts";
import { terminalReadGrant } from "./terminal-grant.ts";
import { terminalResumeResponse } from "./terminal-resume.ts";

const ACCESS = { url: "http://127.0.0.1:52150", token: "bridge-token" };
const PANE = "0f3c9a1e-1111-4222-8333-944455556666";
const LABEL = "WORKER | Sonnet 5.5 | medium";
type SettledState = "done" | "failed" | "blocked" | "waiting" | "working" | "none";

function fixture(state: SettledState = "done") {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot({ name: "Teacher" });
  const report = (text: string, sessionId = PANE) => store.appendMessage(bot.threadId, {
    role: "bot", kind: "note",
    text: `[pane ${sessionId.slice(0, 8)}] [${LABEL}] from Teacher (${bot.id}): ${text}`,
  });
  if (state !== "none") {
    store.appendMessage(bot.threadId, {
      role: "bot", kind: "launch",
      text: `Launched ${LABEL}\nLabel: ${LABEL}\nWorking folder: C:\\repo\nSession: ${PANE}`,
    });
    if (state === "waiting") report("WAITING: this worker is stuck on an on-screen prompt");
    else if (state !== "working") report(`${state === "done" ? "DONE" : state === "failed" ? "FAIL" : "BLOCKED"} WORKER branch=x sha=y dirty=no`);
  }
  const snapshot = {
    sessionId: PANE, label: LABEL, cwd: "C:\\repo",
    panes: [{ sessionId: "main", main: true }, { sessionId: PANE, main: false }],
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshot)));
  const context = { store, access: ACCESS, credentials: requestCredentials(false, false, true, undefined) };
  const post = () => terminalResumeResponse(context, bot.id, { sessionId: PANE }, fetchImpl);
  const rows = () => store.activePath(bot.threadId).filter((message) => message.kind === "launch" && message.text?.startsWith("Resumed "));
  const stateNow = () => listedRuns(workerRuns(store.activePath(bot.threadId)).map((run) => ({ run, state: run.state })), new Set([PANE]))[0]?.state;
  return { store, bot, report, snapshot, fetchImpl, context, post, rows, stateNow };
}

describe("terminal resume route", () => {
  it.each(["done", "failed", "blocked", "waiting"] as const)("marks a %s worker working with the existing launch note", async (state) => {
    const f = fixture(state);
    const result = await f.post();
    expect(result).toMatchObject({ status: 201, body: { resumed: true, messageId: expect.any(String) } });
    expect(f.rows()[0]?.text?.split("\n").slice(0, 4)).toEqual([
      `Resumed ${LABEL}`,
      `Label: ${LABEL}`,
      `Working folder: C:\\repo`,
      `Session: ${PANE}`,
    ]);
    expect(f.rows()[0]?.text?.split("\n")[4]).toMatch(/^Submitted: \d+$/);
    expect(f.stateNow()).toBe("working");
    expect(f.fetchImpl).toHaveBeenCalledWith(`${ACCESS.url}/v1/bots/${f.bot.id}/terminal?sessionId=${PANE}`, expect.objectContaining({
      headers: { authorization: `Bearer ${terminalReadGrant(ACCESS.token, f.bot.id)}` },
    }));
  });

  it.each(["working", "none"] as const)("adds no row for a %s run", async (state) => {
    const f = fixture(state);
    expect(await f.post()).toEqual({ status: 200, body: { resumed: false } });
    expect(f.rows()).toEqual([]);
  });

  it("adds no row for the main terminal even when its transcript contains a run", async () => {
    const f = fixture();
    f.snapshot.panes[1].main = true;
    expect(await f.post()).toEqual({ status: 200, body: { resumed: false } });
    expect(f.rows()).toEqual([]);
  });

  it("records one resume per settlement across simultaneous transports and restart", async () => {
    const f = fixture();
    const phone = { ...f.context, credentials: requestCredentials(true, true, false, undefined) };
    await Promise.all([f.post(), terminalResumeResponse(phone, f.bot.id, { sessionId: PANE }, f.fetchImpl)]);
    expect(f.rows()).toHaveLength(1);
    expect(await f.post()).toEqual({ status: 200, body: { resumed: false } });
    const restarted = { ...f.context, store: new Store(() => ({ instanceId: "claude", model: "fixture" })) };
    expect(await terminalResumeResponse(restarted, f.bot.id, { sessionId: PANE }, f.fetchImpl)).toEqual({ status: 200, body: { resumed: false } });
    f.report("DONE WORKER branch=x sha=y dirty=no");
    expect(f.stateNow()).toBe("done");
    expect(await f.post()).toMatchObject({ status: 201, body: { resumed: true } });
    expect(f.rows()).toHaveLength(2);
  });

  it("does not resume over a newer report during the bridge lookup", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementationOnce(async () => {
      f.report("DONE WORKER branch=x sha=z dirty=no");
      return new Response(JSON.stringify(f.snapshot));
    });
    expect(await f.post()).toEqual({ status: 200, body: { resumed: false } });
    expect(f.rows()).toEqual([]);
    expect(f.stateNow()).toBe("done");
  });

  it("does not apply a notification that arrives after the worker reports again", async () => {
    const f = fixture();
    const afterMessageId = f.store.activePath(f.bot.threadId).at(-1)!.id;
    f.report("DONE WORKER branch=x sha=z dirty=no");
    expect(await terminalResumeResponse(f.context, f.bot.id, { sessionId: PANE, afterMessageId }, f.fetchImpl)).toEqual({ status: 200, body: { resumed: false } });
    expect(f.rows()).toEqual([]);
    expect(f.stateNow()).toBe("done");
  });

  it("uses the latest run for the pane rather than an older settled job", async () => {
    const f = fixture();
    f.store.appendMessage(f.bot.threadId, {
      role: "bot", kind: "launch",
      text: `Launched NEXT\nLabel: NEXT\nWorking folder: C:\\repo\nSession: ${PANE}`,
    });
    expect(f.stateNow()).toBe("working");
    expect(await f.post()).toEqual({ status: 200, body: { resumed: false } });
    expect(f.rows()).toEqual([]);
  });

  it("refuses another bot's pane with the requested bot's bridge grant", async () => {
    const f = fixture();
    const other = f.store.createBot({ name: "Other" });
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unknown terminal" }), { status: 404 }));
    expect(await terminalResumeResponse(f.context, other.id, { sessionId: PANE }, f.fetchImpl)).toEqual({ status: 404, body: { error: "Unknown terminal" } });
    expect(f.fetchImpl).toHaveBeenCalledWith(`${ACCESS.url}/v1/bots/${other.id}/terminal?sessionId=${PANE}`, expect.objectContaining({
      headers: { authorization: `Bearer ${terminalReadGrant(ACCESS.token, other.id)}` },
    }));
    expect(f.rows()).toEqual([]);
    expect(f.store.activePath(other.threadId).some((message) => message.kind === "launch")).toBe(false);
  });

  it.each([{}, { sessionId: "" }, { sessionId: 42 }, null])("refuses invalid resume input %j", async (input) => {
    const f = fixture();
    expect(await terminalResumeResponse(f.context, f.bot.id, input, f.fetchImpl)).toEqual({ status: 400, body: { error: "sessionId is required" } });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { relay: false, paired: false, bearer: true, status: 201 },
    { relay: false, paired: false, bearer: false, status: 401 },
    { relay: true, paired: true, bearer: false, status: 201 },
    { relay: true, paired: false, bearer: true, status: 401 },
  ])("gates relay=$relay paired=$paired bearer=$bearer", async ({ relay, paired, bearer, status }) => {
    const f = fixture();
    f.context.credentials = requestCredentials(relay, paired, bearer, "remote-key");
    const result = await f.post();
    expect(result.status).toBe(status);
    expect(f.rows()).toHaveLength(status === 201 ? 1 : 0);
    if (status === 401) expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the same local remote cookie as terminal send but refuses it over an unpaired relay", async () => {
    const f = fixture();
    const cookie = buildRemoteSetCookie("remote-key").split(";")[0];
    const context = { ...f.context, cookie, credentials: requestCredentials(false, false, false, "remote-key") };
    expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE }, f.fetchImpl)).toMatchObject({ status: 201 });
    context.credentials = requestCredentials(true, false, true, "remote-key");
    expect(await terminalResumeResponse(context, f.bot.id, { sessionId: PANE }, f.fetchImpl)).toMatchObject({ status: 401 });
  });

  it("inherits the terminal send relay Host and Origin gate", () => {
    const host = "desk.wink.bot";
    for (const route of ["send", "resume"]) {
      const req = { method: "POST", url: `/api/bots/bot-1/terminal/${route}`, rawHeaders: ["host", host, "origin", `https://${host}`] };
      expect(relayVerdict(req, host)).toEqual({ kind: "app" });
      expect(relayVerdict({ ...req, rawHeaders: ["host", host] }, host)).toMatchObject({ kind: "deny", status: 403 });
      expect(relayVerdict({ ...req, rawHeaders: ["host", host, "origin", "https://other.example"] }, host)).toMatchObject({ kind: "deny", status: 403 });
    }
  });

  it("wires the module after the same API gate as terminal send", () => {
    // No route seam, so source order proves resume inherits the send gate.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const gate = source.indexOf("!apiRequestAuthorized(credentials.bearerOk");
    const send = source.indexOf("const sent = await terminalSendResponse(");
    const resume = source.indexOf("const resumed = await terminalResumeResponse(");
    expect(gate).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(gate);
    expect(resume).toBeGreaterThan(send);
    expect(source.slice(resume, resume + 240)).toContain("credentials, cookie: req.headers.cookie");
  });
});
