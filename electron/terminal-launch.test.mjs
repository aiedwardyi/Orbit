import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { openBlankTerminal } from "./terminal-launch.mjs";

function launcher(outcomes) {
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    const outcome = outcomes.shift() ?? "spawn";
    queueMicrotask(() => {
      if (outcome === "throw") child.emit("error", new Error("missing terminal"));
      else child.emit("spawn");
    });
    return child;
  };
  return { calls, run };
}

describe("blank terminal launcher", () => {
  it("opens Terminal on macOS without a command argument", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("darwin", fake.run)).resolves.toBe(true);
    expect(fake.calls).toEqual([
      {
        executable: "osascript",
        args: ["-e", 'tell application "Terminal" to activate'],
        options: undefined,
      },
    ]);
  });

  it("opens a visible window on Windows through start, without a profile", async () => {
    const fake = launcher(["spawn"]);
    const deps = { pathEnv: "", pathExt: ".EXE", existsSync: () => false };
    await expect(openBlankTerminal("win32", fake.run, deps)).resolves.toBe(true);
    expect(fake.calls).toEqual([
      {
        executable: "cmd.exe",
        args: ["/c", "start", "", "powershell.exe", "-NoProfile", "-NoExit"],
        options: { windowsHide: true },
      },
    ]);
  });

  it("prefers pwsh on Windows when it is on PATH, still profile-free", async () => {
    const fake = launcher(["spawn"]);
    const deps = {
      pathEnv: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7",
      pathExt: ".COM;.EXE",
      existsSync: (candidate) => candidate.toLowerCase().endsWith("pwsh.exe"),
    };
    await expect(openBlankTerminal("win32", fake.run, deps)).resolves.toBe(true);
    expect(fake.calls).toEqual([
      {
        executable: "cmd.exe",
        args: ["/c", "start", "", "pwsh", "-NoProfile", "-NoExit"],
        options: { windowsHide: true },
      },
    ]);
  });

  it("never passes installer text to the Windows shell", async () => {
    const fake = launcher(["spawn"]);
    const deps = { pathEnv: "", pathExt: ".EXE", existsSync: () => false };
    await openBlankTerminal("win32", fake.run, deps);
    const argv = [fake.calls[0].executable, ...fake.calls[0].args].join(" ");
    for (const needle of ["curl", "install.sh", "http", "bash", "|"]) {
      expect(argv).not.toContain(needle);
    }
  });

  it("tries the next Linux terminal after an asynchronous launch error", async () => {
    const fake = launcher(["throw", "spawn"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls.map((call) => call.executable)).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
    ]);
    expect(fake.calls.every((call) => call.args.length === 0)).toBe(true);
  });

  it("returns false when no Linux terminal launches", async () => {
    const fake = launcher(["throw", "throw", "throw", "throw"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(false);
  });

  it("returns false when the launcher throws synchronously", async () => {
    const run = () => {
      throw new Error("launch failed");
    };
    await expect(openBlankTerminal("darwin", run)).resolves.toBe(false);
  });
});
