// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/updater";

import { UpdateButton } from "./Sidebar";
import { UpdatesRow } from "./SettingsModal";

applyLocale("en");

/** A check whose result lands after the acknowledgement window would have
 * expired if it were timed from the click. */
const SLOW_CHECK_MS = 5000;

function installUpdater() {
  const listeners = new Set<(s: UpdaterState) => void>();
  const emit = (s: UpdaterState) => listeners.forEach((cb) => cb(s));
  const updater = {
    check: () =>
      new Promise<void>((resolve) => {
        emit({ status: "checking" });
        setTimeout(() => {
          emit({ status: "idle" });
          resolve();
        }, SLOW_CHECK_MS);
      }),
    download: () => Promise.resolve(),
    install: () => Promise.resolve(),
    onState: (cb: (s: UpdaterState) => void) => {
      listeners.add(cb);
      cb({ status: "idle" });
      return () => listeners.delete(cb);
    },
  };
  Object.defineProperty(window, "ogb", { value: { updater }, configurable: true, writable: true });
}

async function clickAndSettle(host: HTMLElement) {
  const button = host.querySelector("button")!;
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SLOW_CHECK_MS);
  });
}

describe("manual update check acknowledgement", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    installUpdater();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("ticks the sidebar button when a slow check finds nothing", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdateButton)));
    });
    await clickAndSettle(host);
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("You're up to date");
  });

  it("clears the sidebar tick once the acknowledgement window closes", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdateButton)));
    });
    await clickAndSettle(host);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("Check for updates");
  });

  it("acknowledges a slow check in the Settings updates row", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdatesRow)));
    });
    expect(host.textContent).toContain("You're on the latest version we know of.");
    await clickAndSettle(host);
    expect(host.textContent).toContain("You're up to date");
  });
});
