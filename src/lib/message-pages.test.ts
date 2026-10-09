// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOlderMessages } from "./message-pages";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useOlderMessages", () => {
  it("tells a caller that joined a failing page about the failure", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    let load: ReturnType<typeof useOlderMessages> = () => {};
    function Probe() {
      load = useOlderMessages(vi.fn(), "thread-a", "m1", true);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const first = vi.fn();
    const joined = vi.fn();
    await act(async () => {
      load(undefined, first);
      load(undefined, joined);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
