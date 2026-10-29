import "../components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";

it("exposes the passive focus probe for automatic engine setup checks", async () => {
  let store!: ReturnType<typeof useStore>;
  function Capture() { store = useStore(); return null; }
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  const fetchMock = vi.fn(async (url: string) => url.startsWith("/api/instances")
    ? Response.json({ instances: [] }) : new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
    fetchMock.mockClear();
    await act(async () => store.refreshInstances("passive"));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/instances?refresh=1", expect.any(Object));
    expect(fetchMock.mock.calls.some(([url]) => url.includes("rescan"))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
