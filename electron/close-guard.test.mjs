import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en, ko, translate } from "./i18n.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.mjs"), "utf8");

describe("main window asks before closing while work is running", () => {
  it("routes the main window close through the guard", () => {
    expect(main).toContain('import { createCloseGuard } from "./close-guard.mjs"');
    expect(main).toContain('win.on("close", (event) => {');
    expect(main).toContain("closeGuard.handleClose(event");
  });

  it("counts live worker panes and the last taskbar-busy value", () => {
    expect(main).toContain("workerCount: () => terminalHost.liveWorkerCount()");
    expect(main).toContain("botBusy: () => botBusy");
    const busy = main.slice(main.indexOf('ipcMain.on("desktop:taskbar-busy"'));
    expect(busy.indexOf("botBusy = value === true")).toBeLessThan(busy.indexOf('process.platform !== "win32"'));
  });

  it("shows a quiet native dialog that defaults to Cancel", () => {
    const confirm = main.slice(main.indexOf("const closeGuard"), main.indexOf("function createWindow()"));
    expect(confirm).toContain("dialog.showMessageBox(parent");
    expect(confirm).toContain('type: "none"');
    expect(confirm).toContain("defaultId: 1");
    expect(confirm).toContain("cancelId: 1");
  });

  it("skips the dialog on every deliberate quit and on Windows session end", () => {
    expect(main).toContain('app.on("before-quit", () => closeGuard.leave())');
    expect(main).toContain('win.on("query-session-end", () => closeGuard.leave())');
    expect(main).toContain('win.on("session-end", () => closeGuard.leave())');
    const guard = main.indexOf('app.on("before-quit", () => closeGuard.leave())');
    expect(guard).toBeLessThan(main.indexOf('app.on("before-quit", (e) =>'));
  });

  it("has English and Korean copy for every prompt key", () => {
    for (const key of ["close.title", "close.confirm", "close.cancel", "close.workerOne", "close.workerMany", "close.bot", "close.both"]) {
      expect(en[key]).toBeTruthy();
      expect(ko[key]).toBeTruthy();
    }
    expect(translate("en", "close.workerMany", { count: 2 })).toBe("2 workers are still running. Closing Wink stops them.");
    expect(translate("ko", "close.workerMany", { count: 2 })).toContain("2명");
  });
});
