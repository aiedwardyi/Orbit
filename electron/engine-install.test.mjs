import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { trustedTerminalSender } from "./terminal-host.mjs";
import * as terminal from "./terminal-launch.mjs";

const install = await import("./engine-install.mjs").catch(() => ({}));
const descriptor = { driverKind: "codex", command: "npm install -g official", needsNode: true, signInCommand: "official login" };
const encodedCommand = Buffer.from(`$ErrorActionPreference='Stop'\n${descriptor.command}`, "utf16le").toString("base64");
const encodedSignIn = (script) => Buffer.from(script, "utf16le").toString("base64");

function setup(trusted = true, opened = true) {
  let handler;
  const contents = { isDestroyed: () => false, getURL: () => "http://localhost:5199/", mainFrame: { url: "http://localhost:5199/" } };
  const event = { sender: trusted ? contents : {}, senderFrame: contents.mainFrame };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => descriptor }));
  const copy = vi.fn();
  const open = vi.fn(async () => opened);
  const blank = vi.fn(async () => true);
  install.registerEngineInstall({ handle: (channel, fn) => { expect(channel).toBe("engine:install"); handler = fn; } }, {
    trusted: (caller) => trustedTerminalSender(caller, contents, "http://localhost:5199"),
    server: () => ({ port: 8799, token: "test-token" }), fetch, copy, open, blank,
  });
  return { call: (id, ...rest) => handler(event, id, ...rest), fetch, copy, open, blank };
}

describe("engine install IPC", () => {
  it("resolves only the id and ignores renderer command arguments", async () => {
    const d = setup();
    expect(await d.call("codex", "renderer payload")).toBe("running");
    expect(d.fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/instances/codex/install", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer test-token" } }));
    expect(d.open).toHaveBeenCalledExactlyOnceWith(descriptor);
    expect(JSON.stringify(d.open.mock.calls)).not.toContain("renderer payload");
    expect(d.copy).not.toHaveBeenCalled();
  });

  it.each([[true, false], [undefined, true]])("install-only %s keeps sign-in %s", async (installOnly, signIn) => {
    const d = setup();
    expect(await d.call("codex", installOnly)).toBe("running");
    const script = terminal.buildInstallScript(d.open.mock.calls[0][0], "win32");
    expect(script.includes(encodedSignIn(descriptor.signInCommand))).toBe(signIn);
    expect(script).toContain(encodedCommand);
  });

  it("refuses an untrusted sender before resolving commands", async () => {
    const d = setup(false);
    await expect(d.call("codex")).rejects.toThrow("Untrusted");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it.each(["codex;whoami", "codex login", "", null, { instanceId: "codex", command: "whoami" }])("refuses bad instance id %j", async (id) => {
    const d = setup();
    await expect(d.call(id)).rejects.toThrow("Invalid engine id");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it.each([true, false])("copies the server command on launch failure (blank %s)", async (opened) => {
    const d = setup(true, false);
    d.blank.mockResolvedValue(opened);
    expect(await d.call("codex")).toBe(opened ? "opened" : "copied");
    expect(d.copy).toHaveBeenCalledExactlyOnceWith(descriptor.command);
    expect(d.blank).toHaveBeenCalledOnce();
  });

  it("logs and falls back when launching throws", async () => {
    const d = setup();
    const failure = new Error("launcher failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    d.open.mockRejectedValue(failure);
    try {
      expect(await d.call("codex")).toBe("opened");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[engine-install]"), failure);
      expect(d.copy).toHaveBeenCalledExactlyOnceWith(descriptor.command);
    } finally {
      log.mockRestore();
    }
  });

  it("does not launch a missing server descriptor", async () => {
    const d = setup();
    d.fetch.mockResolvedValue({ ok: false });
    await expect(d.call("missing")).rejects.toThrow();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.blank).not.toHaveBeenCalled();
  });

  it("wires the command-free preload and main handler", () => {
    expect(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8")).toContain('openEngineInstall: (instanceId, installOnly) => ipcRenderer.invoke("engine:install", instanceId, installOnly)');
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    expect(main).toContain("registerEngineInstall(ipcMain,");
    expect(main).toContain("trusted: (event) => trustedTerminalSender(event, mainWindow?.webContents, rendererOrigin())");
  });
});

describe("install terminal script", () => {
  it("checks npm and bootstraps Node before installing", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    expect(script).toContain("Get-Command npm -ErrorAction SilentlyContinue");
    expect(script).toContain("winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements");
    expect(script.indexOf("winget install")).toBeLessThan(script.indexOf(encodedCommand));
  });

  it("refreshes registry PATH before the npm check", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    expect(script.indexOf("[Environment]::GetEnvironmentVariable('Path', 'Machine')")).toBeLessThan(script.indexOf("Get-Command npm"));
  });

  it("never bootstraps Node for an irm installer", () => {
    const script = terminal.buildInstallScript({ ...descriptor, command: "irm https://npm.example.com/install.ps1 | iex" }, "win32");
    expect(script).not.toContain("winget");
    expect(script).toContain("$ErrorActionPreference='Stop'");
  });

  it("refreshes registry PATH after the install and before sign-in", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    const refresh = script.lastIndexOf("[Environment]::GetEnvironmentVariable('Path', 'Machine')");
    expect(refresh).toBeGreaterThan(script.indexOf(encodedCommand));
    expect(refresh).toBeLessThan(script.indexOf(encodedSignIn(descriptor.signInCommand)));
    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
  });

  it.each(["win32", "darwin"])("skips placeholder sign-in on %s", (platform) => {
    const script = terminal.buildInstallScript({ ...descriptor, signInCommand: "official login YOUR_API_KEY" }, platform);
    expect(script).toContain(platform === "win32" ? encodedCommand : descriptor.command);
    expect(script).not.toContain("YOUR_API_KEY");
    if (platform === "win32") expect(script.split("-EncodedCommand")).toHaveLength(2);
  });

  it.each(["win32", "darwin"])("prefixes agy sign-in on %s", (platform) => {
    const script = terminal.buildInstallScript({ ...descriptor, driverKind: "antigravityAgent", signInCommand: "agy" }, platform);
    expect(script).toContain(platform === "win32" ? encodedSignIn("$env:AGY_CLI_DISABLE_AUTO_UPDATE='true'; agy") : "AGY_CLI_DISABLE_AUTO_UPDATE=true agy");
  });

  it("keeps a multi-statement sign-in as one encoded command", () => {
    const signInCommand = "official login\nwhoami; Remove-Item x";
    const plain = terminal.buildInstallScript({ ...descriptor, signInCommand: "official login" }, "win32").split("\n");
    const lines = terminal.buildInstallScript({ ...descriptor, signInCommand }, "win32").split("\n");
    expect(lines).toHaveLength(plain.length);
    expect(lines.at(-1)).toBe(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedSignIn(signInCommand)}`);
    expect(lines.join("\n")).not.toMatch(/whoami|Remove-Item/);
  });

  it.each(["win32", "darwin", "linux"])("launches one script or falls back on %s", async (platform) => {
    const run = vi.fn(() => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    expect(await terminal.openInstallTerminal(descriptor, platform, run)).toBe(platform !== "linux");
    if (platform === "linux") expect(run).not.toHaveBeenCalled();
    else {
      expect(run).toHaveBeenCalledOnce();
      const [file, args] = run.mock.calls[0];
      expect(file).toBe(platform === "win32" ? "cmd.exe" : "osascript");
      if (platform === "win32") {
        expect(args.slice(0, -1)).toEqual(["/c", "start", "", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-EncodedCommand"]);
        expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toBe(terminal.buildInstallScript(descriptor, platform));
      } else expect(args.join(" ")).toContain("do script");
    }
  });
});
