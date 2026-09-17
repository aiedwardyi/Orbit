import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalHost } from "./terminal-host.mjs";

test("real PTY accepts input, resizes, replays output and reports shell exit", { timeout: 20000 }, async (t) => {
  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const owner = { id: 1, mainFrame: {}, send(channel, value) { if (channel === "terminal:exit") finish(value); } };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => os.tmpdir() });
  t.after(() => host.dispose());
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const input = { botId: "smoke", cols: 80, rows: 24 };
  const session = await host.open(event, input);
  await host.resize(event, session.id, 100, 30);
  await host.write(event, session.id, process.platform === "win32" ? "Write-Output ORBIT_PTY_SMOKE; exit 0\r" : "printf ORBIT_PTY_SMOKE; exit 0\n");
  const exit = await exited;
  assert.equal(exit.exitCode, 0);
  const replay = await host.open(event, input);
  assert.match(replay.output, /ORBIT_PTY_SMOKE/);
  assert.ok(replay.seq > 0);
  assert.equal(replay.exitCode, 0);
  host.dispose();
});

test("app shutdown closes its idle shell", { timeout: 20000 }, async (t) => {
  let ready;
  let finish;
  let output = "";
  const started = new Promise((resolve) => { ready = resolve; });
  const exited = new Promise((resolve) => { finish = resolve; });
  const owner = { id: 2, mainFrame: {}, send(channel, value) {
    if (channel === "terminal:data") {
      output += value.data;
      if (/ORBIT_SHELL_PID=(\d+)/.test(output)) ready(Number(output.match(/ORBIT_SHELL_PID=(\d+)/)[1]));
    }
    if (channel === "terminal:exit") finish(value);
  } };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => os.tmpdir() });
  t.after(() => host.dispose());
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const session = await host.open(event, { botId: "shutdown", cols: 80, rows: 24 });
  await host.write(event, session.id, process.platform === "win32" ? "Write-Output ('ORBIT_SHELL_PID=' + $PID)\r" : "echo ORBIT_SHELL_PID=$$\n");
  const pid = await started;
  host.dispose();
  await exited;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
