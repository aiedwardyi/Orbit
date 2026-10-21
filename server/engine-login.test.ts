import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { EngineLogin } from "./engine-login.ts";

const managers: EngineLogin[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(timeout = 5000, capture = 500) {
  const dir = mkdtempSync(join(tmpdir(), "engine-login-"));
  dirs.push(dir);
  const script = join(dir, "login.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [mode, file] = process.argv.slice(2);
    if (mode === 'tree') {
      const child = spawn(process.execPath, ['-e',
        'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "."), 25)', file], { stdio: 'ignore', windowsHide: true });
      fs.writeFileSync(file + '.pid', String(child.pid));
    }
    if (mode === 'env') fs.writeFileSync(file, process.env.MUSE_LOGIN || 'missing');
    if (mode === 'credentials') fs.writeFileSync(file, JSON.stringify({
      token: process.env.OMB_COMMS_TOKEN, key: process.env.ANTHROPIC_API_KEY,
      extra: process.env.SIGNIN_REVIEW_SECRET, config: process.env.CLAUDE_CONFIG_DIR,
    }));
    if (mode === 'count') fs.appendFileSync(file, '.');
    process.stdin.on('end', () => process.exit(130));
    process.stdin.resume();
    process.stdout.write('access_token=private-token\\n');
    if (mode === 'unsafe') process.stdout.write('https://auth.example/?access_token=private-token\\nhttps://user:password@auth.example/device\\nnoise ABCD-EFGH\\n');
    else (mode === 'stdout' ? process.stdout : process.stderr).write('\\x1b]8;;https://auth.example/device\\x1b\\\\\\x1b[32mhttps://auth.example/device\\x1b[0m\\x1b]8;;\\x1b\\\\\\n');
    if (mode === 'chunks') {
      process.stdout.write('Co');
      setTimeout(() => process.stdout.write('de: ABCD-EFGH\\n'), 30);
    } else if (mode !== 'unsafe') process.stdout.write('Code: ABCD-EFGH\\n');
    if (mode === 'exit') setTimeout(() => process.exit(0), 100);
    else if (mode === 'fail') setTimeout(() => process.exit(1), 100);
    else setInterval(() => {}, 1000);
  `);
  const manager = new EngineLogin(timeout, capture);
  managers.push(manager);
  return { manager, cli: `"${process.execPath}" "${script}"`, dir };
}

describe("EngineLogin", () => {
  it("does not inherit credentials outside the supplied login environment", async () => {
    vi.stubEnv("OMB_COMMS_TOKEN", "review-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "review-key");
    vi.stubEnv("SIGNIN_REVIEW_SECRET", "review-secret");
    const { manager, cli, dir } = fixture();
    const file = join(dir, "credentials");
    await manager.start("claude", cli, ["credentials", file], { CLAUDE_CONFIG_DIR: dir });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ config: dir });
  });

  it("settles cancellation when the killed child never emits close", async () => {
    const { manager, cli } = fixture();
    const closeListeners: ((...args: unknown[]) => void)[] = [];
    const { ChildProcess } = await import("node:child_process");
    const original = ChildProcess.prototype.once;
    const once = vi.spyOn(ChildProcess.prototype, "once");
    once.mockImplementation(function (this: import("node:child_process").ChildProcess, event, listener) {
      if (event === "close") { closeListeners.push(listener); return this; }
      return original.call(this, event, listener);
    });
    await manager.start("fake", cli, ["normal"]);
    expect(closeListeners.length).toBeGreaterThan(0);
    const settled = await Promise.race([
      manager.cancel("fake").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
    ]);
    once.mockRestore();
    if (!settled) for (const listener of closeListeners) listener(null, "SIGTERM");
    expect(settled).toBe(true);
  });

  it.each(["normal", "chunks", "stdout"])("captures only URL and code from %s output", async (mode) => {
    const { manager, cli } = fixture();
    expect(await manager.start("fake", cli, [mode])).toEqual({ url: "https://auth.example/device", code: "ABCD-EFGH" });
    expect(JSON.stringify(manager.capture("fake"))).not.toContain("private-token");
    expect(manager.state("fake")).toBe("pending");
  });

  it("keeps stdin open until cancellation", async () => {
    const { manager, cli } = fixture();
    await manager.start("fake", cli, ["normal"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(manager.state("fake")).toBe("pending");
    await manager.cancel("fake");
    expect(manager.state("fake")).toBe("cancelled");
  });

  it("drops unanchored codes and URLs carrying credentials", async () => {
    const { manager, cli } = fixture(5000, 150);
    expect(await manager.start("fake", cli, ["unsafe"])).toEqual({});
  });

  it("starts one replacement after a cancelled job", async () => {
    const { manager, cli, dir } = fixture();
    await manager.start("fake", cli, ["normal"]);
    await manager.cancel("fake");
    const file = join(dir, "restarted");
    await Promise.all([manager.start("fake", cli, ["count", file]), manager.start("fake", cli, ["count", file])]);
    expect(readFileSync(file, "utf8")).toBe(".");
  });

  it("does not launch a queued replacement during shutdown", async () => {
    const { manager, cli, dir } = fixture();
    await manager.start("fake", cli, ["normal"]);
    const cancel = manager.cancel("fake");
    const file = join(dir, "unexpected-start");
    const restart = manager.start("fake", cli, ["count", file]);
    await Promise.all([cancel, restart, manager.dispose()]);
    expect(existsSync(file)).toBe(false);
    expect(manager.state("fake")).toBeUndefined();
  });

  it("reuses one running job for simultaneous starts", async () => {
    const { manager, cli, dir } = fixture();
    const file = join(dir, "count");
    const captures = await Promise.all([manager.start("fake", cli, ["count", file]), manager.start("fake", cli, ["count", file])]);
    expect(captures[0]).toEqual(captures[1]);
    expect(readFileSync(file, "utf8")).toBe(".");
  });

  it.each(["cancel", "timeout", "shutdown"])("kills the process tree on %s", async (action) => {
    const { manager, cli, dir } = fixture(action === "timeout" ? 800 : 5000);
    const file = join(dir, "heartbeat");
    await manager.start("fake", cli, ["tree", file]);
    await expect.poll(() => existsSync(file)).toBe(true);
    if (action === "cancel") await manager.cancel("fake");
    else if (action === "shutdown") await manager.dispose();
    else await expect.poll(() => manager.state("fake")).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const size = readFileSync(file).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(file).length).toBe(size);
  });

  it("passes the Muse launcher environment", async () => {
    const { manager, cli, dir } = fixture();
    const file = join(dir, "env");
    await manager.start("muse", cli, ["env", file], { MUSE_LOGIN: "0" });
    expect(readFileSync(file, "utf8")).toBe("0");
  });

  it.each(["exit", "fail"])("records the %s outcome without returning output", async (mode) => {
    const { manager, cli } = fixture();
    const result = await manager.start("fake", cli, [mode]);
    await expect.poll(() => manager.state("fake")).toBe(mode === "exit" ? "complete" : "failed");
    expect(Object.keys(result).sort()).toEqual(["code", "url"]);
  });

  it("handles an absent CLI without exposing its error", async () => {
    const { manager, dir } = fixture();
    expect(await manager.start("missing", join(dir, "absent.exe"), [])).toEqual({});
    expect(manager.state("missing")).toBe("failed");
  });
});
