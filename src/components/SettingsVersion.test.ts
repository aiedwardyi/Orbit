// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/updater";

import { UpdatesRow } from "./SettingsModal";

applyLocale("en");

function installOgb(appVersion?: string) {
  const updater = {
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    install: () => Promise.resolve(),
    onState: (cb: (s: UpdaterState) => void) => {
      cb({ status: "idle" });
      return () => {};
    },
  };
  const ogb =
    appVersion === undefined ? { updater } : { updater, getAppVersion: () => Promise.resolve(appVersion) };
  Object.defineProperty(window, "ogb", { value: ogb, configurable: true, writable: true });
}

describe("settings version label", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the installed version next to the check button", async () => {
    installOgb("1.0.41");
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdatesRow)));
    });
    expect(host.textContent).toContain("v1.0.41");
    expect(host.querySelector("button")!.textContent).toBe("Check for updates");
  });

  it("renders the button alone when the bridge has no version", async () => {
    installOgb();
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdatesRow)));
    });
    expect(host.textContent).not.toMatch(/v\d+\.\d+/);
    expect(host.querySelector("button")!.textContent).toBe("Check for updates");
  });
});
