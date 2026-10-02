// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "./store";

class FakeEventSource {
  onmessage = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;
let probes = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  probes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url) !== "/api/instances") return new Promise<Response>(() => {});
    probes += 1;
    return Response.json({ instances: [] });
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null)));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function away(ms: number) {
  await act(async () => window.dispatchEvent(new Event("blur")));
  vi.setSystemTime(Date.now() + ms);
  await act(async () => window.dispatchEvent(new Event("focus")));
}

describe("engine re-probe on focus", () => {
  it("re-probes when the user comes back from a trip away", async () => {
    const before = probes;
    await away(30_000);
    expect(probes).toBe(before + 1);
  });

  it("ignores quick focus bounces", async () => {
    const before = probes;
    for (let i = 0; i < 5; i++) await away(4_000);
    expect(probes).toBe(before);
  });

  it("does not loop when its own probe steals focus, however long the flash stays up", async () => {
    await away(30_000);
    const after = probes;
    await away(6_000);
    expect(probes).toBe(after);
  });

  it("re-probes on a real trip away after a flash", async () => {
    await away(30_000);
    await away(6_000);
    const after = probes;
    vi.setSystemTime(Date.now() + 10_000);
    await away(30_000);
    expect(probes).toBe(after + 1);
  });
});
