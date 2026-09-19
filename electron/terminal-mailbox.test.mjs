import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mailboxGrant as serverGrant } from "../server/mailbox.ts";
import { createTerminalHost } from "./terminal-host.mjs";
import { mailboxGrant, terminalPaneEnv } from "./terminal-mailbox.mjs";

function fixture(mailbox) {
  const spawned = [];
  const owner = { id: 1, isDestroyed: () => false, send: () => {} };
  const host = createTerminalHost({
    authorize: () => {},
    resolveCwd: async () => os.tmpdir(),
    mailbox,
    platform: "linux",
    env: { SHELL: "/bin/sh", PATH: "/usr/bin", ORBIT_PANE: "inherited", OMB_COMMS_TOKEN: "leak" },
    loadPty: () => ({ spawn: (_shell, _args, options) => {
      spawned.push(options.env);
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    } }),
  });
  return { host, spawned, event: { sender: owner }, input: { botId: "bot-1", cols: 80, rows: 24 } };
}

describe("terminal pane env", () => {
  it("tags every pane and scopes the grant to it", async () => {
    const f = fixture(async () => ({ url: "http://127.0.0.1:8799", token: "secret", binDir: "/orbit/bin" }));
    const session = await f.host.open(f.event, f.input);
    const env = f.spawned[0];
    expect(env).toMatchObject({ ORBIT_PANE: session.id, ORBIT_BOT: "bot-1", ORBIT_TEACHER: "bot-1", ORBIT_URL: "http://127.0.0.1:8799" });
    expect(env.ORBIT_MSG_TOKEN).toBe(serverGrant("secret", session.id, "bot-1", "bot-1"));
    expect(env.ORBIT_MSG_TOKEN).not.toContain("secret");
    expect(env.OMB_COMMS_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(`/orbit/bin${path.delimiter}/usr/bin`);
  });

  it("still opens the pane when the mailbox is unavailable", async () => {
    const f = fixture(async () => { throw new Error("no server"); });
    const session = await f.host.open(f.event, f.input);
    expect(f.spawned[0]).toMatchObject({ ORBIT_PANE: session.id, ORBIT_BOT: "bot-1", ORBIT_TEACHER: "bot-1" });
    expect(f.spawned[0].ORBIT_URL).toBeUndefined();
    expect(f.spawned[0].ORBIT_MSG_TOKEN).toBeUndefined();
  });

  it("prepends to a Windows-cased Path key", () => {
    const env = terminalPaneEnv({ Path: "system" }, { pane: "p", bot: "b", mailbox: { url: "u", token: "t", binDir: "orbit-bin" } });
    expect(env.Path).toBe(`orbit-bin${path.delimiter}system`);
    expect(env.PATH).toBeUndefined();
  });

  it("refuses ids that could forge another triple", () => {
    expect(() => mailboxGrant("t", "a:b", "c", "d")).toThrow(/grant/);
  });
});
