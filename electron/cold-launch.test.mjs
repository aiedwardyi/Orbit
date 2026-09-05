import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.mjs"), "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from === -1 ? 0 : from + start.length);
  if (from < 0 || to < 0) {
    throw new Error(`missing source markers ${JSON.stringify(start)} .. ${JSON.stringify(end)}`);
  }
  return source.slice(from, to);
}

describe("packaged cold launch does not hide the window behind the harness", () => {
  it("creates and shows the window before awaiting startServerPackaged", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    const windowAt = ready.indexOf("createWindow()");
    const serverAt = ready.indexOf("await startServerPackaged()");
    expect(windowAt).toBeGreaterThan(-1);
    expect(serverAt).toBeGreaterThan(-1);
    expect(windowAt).toBeLessThan(serverAt);
  });

  it("loads a local connecting page when the packaged child is not up yet", () => {
    const create = sourceBetween(main, "function createWindow() {", "function revealPackagedApp(");
    expect(create).toContain("buildConnectingPage(");
    expect(create).toContain("win.show()");
    expect(main).toContain("function revealPackagedApp(");
    expect(main).toContain("buildConnectingPage(");
  });

  it("starts CUA after the first window exists so the daemon does not contend with first paint", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    expect(ready.indexOf("createWindow()")).toBeLessThan(ready.indexOf("startCua()"));
  });

  it("does not start the built-in browser host until the real UI is revealed", () => {
    const create = sourceBetween(main, "function createWindow() {", "function revealPackagedApp(");
    expect(create).not.toContain("void startBrowserSurface(win)");
    expect(main).toMatch(/function revealPackagedApp\([\s\S]*startBrowserSurface/);
  });

  it("runs packaged smoke against the harness URL, not the connecting page", () => {
    expect(main).toContain("isPackagedAppUrl(");
    expect(main).toContain("OMB_SMOKE_TEST");
  });
});
