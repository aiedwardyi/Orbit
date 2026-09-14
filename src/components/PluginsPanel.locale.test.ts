import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {},
      dispatch: () => undefined,
    }),
  };
});

import { I18nProvider } from "@/lib/i18n";
import { PluginsPanel } from "./PluginsPanel";

let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PluginsPanel Korean connected apps", () => {
  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("renders the title, view tabs, and unavailable notice in Korean", async () => {
    const backing = new Map<string, string>([["omb-locale", "ko"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = String(input);
      const body = url.includes("/api/connectors/catalog")
        ? { cards: [], source: "curated", configured: false, mode: "unavailable" }
        : url.includes("/api/connectors/connected")
          ? { services: {}, authoritative: true }
          : {};
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      };
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(I18nProvider, null, createElement(PluginsPanel)));
    });
    await flush();
    await flush();

    const title = host.querySelector("#connected-apps-title");
    expect(title?.textContent).toBe("연결 앱");

    const tablist = host.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("연결 앱 보기");

    const body = host.textContent ?? "";
    expect(body).toContain("일시적으로");
    expect(body).not.toContain("Connected apps view");
    expect(body).not.toContain("temporarily unavailable");
  });
});
