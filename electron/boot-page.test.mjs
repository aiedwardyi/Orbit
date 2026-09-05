import { describe, expect, it } from "vitest";

import {
  BOOT_FAILED,
  BOOT_READY,
  buildConnectingPage,
  isConnectingPageUrl,
  isFailedBootPageUrl,
  isPackagedAppUrl,
  markFailedBootPage,
  shouldDeliverPackageInstall,
  shouldReloadPackagedWindow,
  shouldStartPackagedSmoke,
} from "./boot-page.mjs";

describe("packaged connecting page", () => {
  it("is a data URL that paints the skin color and connecting copy", () => {
    const href = buildConnectingPage({
      locale: "en",
      fontStack: "system-ui,sans-serif",
      backgroundColor: "#0a0a0b",
      message: "Connecting to the bot server…",
    });
    expect(href.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(href.slice("data:text/html;charset=utf-8,".length));
    expect(html).toContain('lang="en"');
    expect(html).toContain("#0a0a0b");
    expect(html).toContain("Connecting to the bot server…");
    expect(html).toContain("system-ui,sans-serif");
    expect(html).not.toContain("Couldn't start");
    expect(html).toContain('data-orbit-boot="connecting"');
    expect(isConnectingPageUrl(href)).toBe(true);
    expect(isFailedBootPageUrl(href)).toBe(false);
  });
});

describe("packaged boot-phase URL policy", () => {
  const connecting = buildConnectingPage({
    locale: "en",
    fontStack: "system-ui",
    backgroundColor: "#111",
    message: "Connecting to the bot server…",
  });
  const failed = "data:text/html;charset=utf-8," + encodeURIComponent(markFailedBootPage('<html lang="en"><body>down</body>'));

  it("holds package-install until the real harness document loads", () => {
    expect(shouldDeliverPackageInstall(connecting, 8799)).toBe(false);
    expect(shouldDeliverPackageInstall(failed, 8799)).toBe(false);
    expect(shouldDeliverPackageInstall("http://127.0.0.1:8799/", 8799)).toBe(true);
  });

  it("starts smoke on the harness or the failed page, never the connecting page", () => {
    expect(shouldStartPackagedSmoke(connecting, 8799)).toBe(false);
    expect(shouldStartPackagedSmoke(failed, 8799)).toBe(true);
    expect(shouldStartPackagedSmoke("http://127.0.0.1:8799/", 8799)).toBe(true);
    expect(isFailedBootPageUrl(failed)).toBe(true);
  });

  it("does not reload a window that already shows the destination phase", () => {
    expect(shouldReloadPackagedWindow(connecting, 8799, "connecting")).toBe(false);
    expect(shouldReloadPackagedWindow("http://127.0.0.1:8799/", 8799, BOOT_READY)).toBe(false);
    expect(shouldReloadPackagedWindow(failed, 8799, BOOT_FAILED)).toBe(false);
    expect(shouldReloadPackagedWindow(connecting, 8799, BOOT_READY)).toBe(true);
    expect(shouldReloadPackagedWindow(connecting, 8799, BOOT_FAILED)).toBe(true);
  });
});

describe("isPackagedAppUrl", () => {
  it("accepts only the loopback harness origin for this boot's port", () => {
    expect(isPackagedAppUrl("http://127.0.0.1:8799/", 8799)).toBe(true);
    expect(isPackagedAppUrl("http://127.0.0.1:8799", 8799)).toBe(true);
    expect(isPackagedAppUrl("http://127.0.0.1:18799/", 8799)).toBe(false);
    expect(isPackagedAppUrl("data:text/html,boot", 8799)).toBe(false);
    expect(isPackagedAppUrl("http://localhost:8799/", 8799)).toBe(false);
  });
});
