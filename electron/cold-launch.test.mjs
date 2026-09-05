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
    expect(create).toContain("packagedWindowHref(");
    expect(create).toContain("buildConnectingPage(");
    expect(create).toContain("win.show()");
    expect(main).toContain("function revealPackagedApp(");
    expect(main).toContain("buildConnectingPage(");
  });

  it("starts CUA after the first window exists so the daemon does not contend with first paint", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    expect(ready.indexOf("createWindow()")).toBeLessThan(ready.indexOf("startCua()"));
  });

  it("overlaps credential I/O with first paint instead of awaiting keys first", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    const start = ready.indexOf("loadSecureCredentials()");
    const windowAt = ready.indexOf("createWindow()");
    const awaitCreds = ready.search(/await credentialsReady/);
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(windowAt);
    expect(windowAt).toBeLessThan(awaitCreds);
  });

  it("reveals the live main window so a closed connecting page cannot stick", () => {
    const reveal = sourceBetween(main, "function revealPackagedApp(", "async function runPackagedSmoke");
    expect(reveal).toContain("livePackagedWindow(");
    expect(reveal).toContain("shouldReloadPackagedWindow(");
    expect(reveal).toMatch(/packagedBootPhase = serverReady \? BOOT_READY : BOOT_FAILED/);
    expect(reveal).toContain("createWindow()");
    expect(reveal).toMatch(/target\.isDestroyed\(\)/);
    expect(reveal).toContain("startBrowserSurface(target)");
  });

  it("registers activate before the packaged harness wait", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    const windowAt = ready.indexOf("createWindow()");
    const activateAt = ready.indexOf("app.on(\"activate\"");
    const serverAt = ready.indexOf("await startServerPackaged()");
    expect(windowAt).toBeGreaterThan(-1);
    expect(activateAt).toBeGreaterThan(windowAt);
    expect(activateAt).toBeLessThan(serverAt);
  });

  it("does not consume orbit://install on the connecting page", () => {
    const deliver = sourceBetween(main, "function deliverPackageInstall(", "function queuePackageInstall(");
    expect(deliver).toContain("shouldDeliverPackageInstall(");
  });

  it("starts the browser surface at most once per window", () => {
    const start = sourceBetween(main, "async function startBrowserSurface(owner) {", "function browserSurfaceForEvent");
    expect(start).toMatch(/browserSurfaceOwner === owner/);
    expect(start).toMatch(/owner.isDestroyed\(\) \|\| browserSurfaceOwner !== owner/);
    expect(start).toMatch(/if \(browserSurfaceOwner === owner\) \{\s*browserSurface = null/);
  });

  it("does not start the built-in browser host until the real UI is revealed", () => {
    const create = sourceBetween(main, "function createWindow() {", "function revealPackagedApp(");
    expect(create).not.toContain("void startBrowserSurface(win)");
    expect(main).toMatch(/function revealPackagedApp\([\s\S]*startBrowserSurface/);
  });

  it("runs packaged smoke against the harness URL, not the connecting page", () => {
    expect(main).toContain("shouldStartPackagedSmoke(");
    expect(main).toContain("isPackagedAppUrl(");
    expect(main).toContain("OMB_SMOKE_TEST");
  });

  it("forks the thin packaged-boot entry so health can answer before the fat harness parses", () => {
    expect(main).toContain("packaged-boot.js");
    expect(main).toMatch(/server", "packaged-boot\.js"/);
  });

  it("reveals the live UI before packaged credential migrations", () => {
    const ready = sourceBetween(main, "app.whenReady().then(async () => {", "app.on(\"window-all-closed\"");
    const revealAt = ready.indexOf("revealPackagedApp(win)");
    const composioAt = ready.indexOf("secureComposioConfig()");
    const workspaceAt = ready.indexOf("secureWorkspaceConfig()");
    const serverAt = ready.indexOf("await startServerPackaged()");
    expect(revealAt).toBeGreaterThan(-1);
    expect(composioAt).toBeGreaterThan(-1);
    expect(workspaceAt).toBeGreaterThan(-1);
    expect(serverAt).toBeGreaterThan(-1);
    expect(serverAt).toBeLessThan(revealAt);
    expect(revealAt).toBeLessThan(composioAt);
    expect(revealAt).toBeLessThan(workspaceAt);
    expect(ready.indexOf("await secureComposioConfig()")).toBeGreaterThan(revealAt);
    expect(ready.indexOf("await secureWorkspaceConfig()")).toBeGreaterThan(revealAt);
  });
});
