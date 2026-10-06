import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyStartFresh, requestStartFresh, resetMarkerPath } from "./start-fresh.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-reset-"));
  roots.push(root);
  const dataDir = path.join(root, ".orbit");
  const userData = path.join(root, "desktop");
  const drive = path.join(root, "Drive");
  for (const dir of [dataDir, userData, drive]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dataDir, "messages.db"), "all conversations");
  fs.writeFileSync(path.join(dataDir, "profile-sync.json"), JSON.stringify({ folder: drive, deviceId: "old-pc" }));
  fs.writeFileSync(path.join(userData, "credentials.bin"), "encrypted keys");
  fs.writeFileSync(path.join(userData, "locale-preference.json"), '"ko"');
  fs.writeFileSync(path.join(userData, "companion-settings.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(userData, "cua-local-control.json"), JSON.stringify({ enabled: true }));
  fs.mkdirSync(path.join(userData, "Partitions", "browser-work"), { recursive: true });
  fs.writeFileSync(path.join(userData, "Partitions", "browser-work", "Cookies"), "browser login");
  for (const name of [".claude", ".codex", ".grok", ".gemini", "muse", "projects"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "keep"), name);
  }
  fs.writeFileSync(path.join(drive, "remote.json"), "other PCs");
  const clearUiState = vi.fn(async () => {});
  return { dataDir, userData, drive, clearUiState, now: new Date(2026, 9, 6, 18, 25, 0), sleep: async () => {} };
}

describe("start fresh", () => {
  it("only writes an outside marker when requested", () => {
    const input = fixture();
    requestStartFresh(input);
    expect(path.dirname(resetMarkerPath(input.dataDir))).toBe(path.dirname(input.dataDir));
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(true);
    expect(fs.readFileSync(path.join(input.dataDir, "messages.db"), "utf8")).toBe("all conversations");
    expect(fs.existsSync(path.join(input.userData, "credentials.bin"))).toBe(true);
  });

  it("renames the complete folder and saved secrets, clears the marker and UI, and leaves Drive untouched", async () => {
    const input = fixture();
    const before = fs.readFileSync(path.join(input.drive, "remote.json"));
    requestStartFresh(input);
    const result = await applyStartFresh(input);
    expect(result.status).toBe("reset");
    expect(result.backup).toBe(`${input.dataDir}-backup-20261006-182500`);
    expect(fs.readFileSync(path.join(result.backup, "messages.db"), "utf8")).toBe("all conversations");
    expect(fs.readFileSync(path.join(result.backup, "desktop-state", "credentials.bin"), "utf8")).toBe("encrypted keys");
    expect(fs.existsSync(path.join(input.userData, "credentials.bin"))).toBe(false);
    expect(fs.existsSync(path.join(input.userData, "locale-preference.json"))).toBe(false);
    expect(fs.existsSync(path.join(input.userData, "companion-settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(input.userData, "cua-local-control.json"))).toBe(false);
    expect(fs.existsSync(input.dataDir)).toBe(false);
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(false);
    expect(input.clearUiState).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(input.drive, "remote.json"))).toEqual(before);
    expect(fs.readdirSync(input.drive)).toEqual(["remote.json"]);
    expect(fs.readFileSync(path.join(input.userData, "Partitions", "browser-work", "Cookies"), "utf8")).toBe("browser login");
    for (const name of [".claude", ".codex", ".grok", ".gemini", "muse", "projects"]) {
      expect(fs.readFileSync(path.join(path.dirname(input.dataDir), name, "keep"), "utf8")).toBe(name);
    }
  });

  it("still resets when the sync settings are unreadable", async () => {
    const input = fixture();
    fs.writeFileSync(path.join(input.dataDir, "profile-sync.json"), "{");
    requestStartFresh(input);
    expect((await applyStartFresh(input)).status).toBe("reset");
    expect(fs.existsSync(input.dataDir)).toBe(false);
  });

  it("preserves an existing backup and adds a collision suffix", async () => {
    const input = fixture();
    const existing = `${input.dataDir}-backup-20261006-182500`;
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "keep"), "older backup");
    requestStartFresh(input);
    expect((await applyStartFresh(input)).backup).toBe(`${existing}-1`);
    expect(fs.readFileSync(path.join(existing, "keep"), "utf8")).toBe("older backup");
  });

  it("starts with sync off and a new device identity", async () => {
    const input = fixture();
    const previous = process.env.OMB_DATA_DIR;
    process.env.OMB_DATA_DIR = input.dataDir;
    try {
      const { loadProfileSyncSettings, saveProfileSyncSettings } = await import("../server/profile-sync.ts");
      const settings = loadProfileSyncSettings(input.dataDir);
      saveProfileSyncSettings(input.dataDir, { ...settings, folder: input.drive, syncChats: true });
      requestStartFresh(input);
      expect((await applyStartFresh(input)).status).toBe("reset");
      const fresh = loadProfileSyncSettings(input.dataDir);
      expect(fresh.folder).toBeNull();
      expect(fresh.syncChats).toBe(false);
      expect(fresh.deviceId).not.toBe(settings.deviceId);
    } finally {
      if (previous === undefined) delete process.env.OMB_DATA_DIR;
      else process.env.OMB_DATA_DIR = previous;
    }
  });

  it("retries a locked folder then restores secrets and starts normally without a marker", async () => {
    const input = fixture();
    const rename = vi.fn((from, to) => {
      if (from === input.dataDir) throw Object.assign(new Error("locked"), { code: "EPERM" });
      fs.renameSync(from, to);
    });
    requestStartFresh(input);
    expect((await applyStartFresh({ ...input, rename })).status).toBe("failed");
    expect(rename.mock.calls.filter(([from]) => from === input.dataDir).length).toBeGreaterThan(1);
    expect(fs.readFileSync(path.join(input.dataDir, "messages.db"), "utf8")).toBe("all conversations");
    expect(fs.readFileSync(path.join(input.userData, "credentials.bin"), "utf8")).toBe("encrypted keys");
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(false);
    expect(input.clearUiState).not.toHaveBeenCalled();
  });

  it("does nothing without a marker", async () => {
    const input = fixture();
    expect((await applyStartFresh(input)).status).toBe("none");
    expect(input.clearUiState).not.toHaveBeenCalled();
    expect(fs.existsSync(input.dataDir)).toBe(true);
  });

  it("finishes after a transient rename lock", async () => {
    const input = fixture();
    let attempts = 0;
    const rename = (from, to) => {
      if (from === input.dataDir && attempts++ === 0) throw new Error("locked");
      fs.renameSync(from, to);
    };
    requestStartFresh(input);
    expect((await applyStartFresh({ ...input, rename })).status).toBe("reset");
    expect(attempts).toBe(2);
  });

  it("restores earlier files when a later desktop file cannot move", async () => {
    const input = fixture();
    requestStartFresh(input);
    const rename = (from, to) => {
      if (from === path.join(input.userData, "locale-preference.json")) throw new Error("locked");
      fs.renameSync(from, to);
    };
    expect((await applyStartFresh({ ...input, rename })).status).toBe("failed");
    expect(fs.readFileSync(path.join(input.userData, "credentials.bin"), "utf8")).toBe("encrypted keys");
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(false);
    expect(fs.readdirSync(input.dataDir).sort()).toEqual(["messages.db", "profile-sync.json"]);
  });

  it("resumes UI cleanup after interruption without renaming again", async () => {
    const input = fixture();
    requestStartFresh(input);
    await expect(applyStartFresh({ ...input, clearUiState: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(true);
    const rename = vi.fn();
    expect((await applyStartFresh({ ...input, rename })).status).toBe("reset");
    expect(rename).not.toHaveBeenCalled();
    expect(input.clearUiState).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(false);
  });

  it("refuses a data folder that overlaps the sync folder", async () => {
    const input = fixture();
    fs.writeFileSync(path.join(input.dataDir, "profile-sync.json"), JSON.stringify({ folder: input.dataDir }));
    requestStartFresh(input);
    const rename = vi.fn();
    expect((await applyStartFresh({ ...input, rename })).status).toBe("failed");
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(input.dataDir, "messages.db"), "utf8")).toBe("all conversations");
    expect(fs.existsSync(resetMarkerPath(input.dataDir))).toBe(false);
  });

  it("requests one relaunch through normal quit and handles the marker before boot work", () => {
    const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const handler = source.match(/let startFreshRequested = false;[\s\S]*?\n\}\);/)?.[0];
    expect(handler).toBeTruthy();
    const calls = [];
    let invoke;
    let trusted = false;
    runInNewContext(handler, {
      ipcMain: { handle: (_name, callback) => { invoke = callback; } },
      app: { isPackaged: true, getPath: () => "home", relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") },
      mainWindow: { webContents: {} }, rendererOrigin: () => "http://localhost",
      trustedTerminalSender: () => trusted,
      requestStartFresh: () => calls.push("marker"), process: { env: {} }, path,
    });
    expect(() => invoke({})).toThrow("installed main window");
    expect(calls).toEqual([]);
    trusted = true;
    invoke({});
    invoke({});
    expect(calls).toEqual(["marker", "relaunch", "quit"]);
    const boot = source.slice(source.indexOf("app.whenReady().then(async () => {"));
    expect(boot.indexOf("await applyStartFresh(")).toBeGreaterThan(0);
    for (const operation of ["loadSecureCredentials()", "createWindow()", "startServerPackaged()", "ensureCompanionAccountService()"]) {
      expect(boot.indexOf(operation)).toBeGreaterThan(boot.indexOf("await applyStartFresh("));
    }
    expect(boot).toContain("clearUiState: () => session.defaultSession.clearStorageData()");
  });
});
