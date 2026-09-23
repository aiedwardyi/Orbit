import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveEventSourceLike, LiveEventsPlatform } from "./live-events";
import { updaterActions, watchRemoteUpdater, type UpdaterState } from "./updater";

class FakeEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  message(frame: Record<string, unknown>, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

function platform() {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const value: Partial<LiveEventsPlatform> = {
    createEventSource: (url) => {
      const source = new FakeEventSource();
      sources.push(source);
      urls.push(url);
      return source;
    },
    isOnline: () => true,
    isVisible: () => true,
    now: () => 0,
  };
  return { sources, urls, value };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote updater fallback", () => {
  it("loads state on a fresh stream, then follows update.state frames", async () => {
    const seen: Array<UpdaterState | null> = [];
    const live = platform();
    const load = vi.fn(async () => ({ status: "available", version: "1.0.53", appVersion: "1.0.52" }) as UpdaterState);
    const stop = watchRemoteUpdater((s) => seen.push(s), load, live.value);
    live.sources[0].message({ kind: "hello", resumed: false, cursor: "a:1" });
    await flush();
    live.sources[0].message({ kind: "update.state", state: { status: "downloading", percent: 40 } }, "a:2");
    live.sources[0].message({ kind: "message", threadId: "t1" }, "a:3");
    expect(seen).toEqual([
      { status: "available", version: "1.0.53", appVersion: "1.0.52" },
      { status: "downloading", percent: 40 },
    ]);
    stop();
    expect(live.sources[0].close).toHaveBeenCalled();
  });

  it("hides the card when the desktop updater is unavailable", async () => {
    const seen: Array<UpdaterState | null> = [];
    const live = platform();
    const stop = watchRemoteUpdater((s) => seen.push(s), async () => ({ status: "unavailable" }), live.value);
    live.sources[0].message({ kind: "hello", resumed: false, cursor: "a:1" });
    await flush();
    expect(seen).toEqual([null]);
    stop();
  });

  it("keeps a pushed frame over a slower load", async () => {
    const seen: Array<UpdaterState | null> = [];
    const live = platform();
    let resolve: (s: UpdaterState) => void = () => {};
    const load = () => new Promise<UpdaterState>((done) => (resolve = done));
    const stop = watchRemoteUpdater((s) => seen.push(s), load, live.value);
    live.sources[0].message({ kind: "hello", resumed: false, cursor: "a:1" });
    live.sources[0].message({ kind: "update.state", state: { status: "installing" } }, "a:2");
    resolve({ status: "downloaded", version: "1.0.53" });
    await flush();
    expect(seen).toEqual([{ status: "installing" }]);
    stop();
  });

  it("retries the fresh stream when the snapshot load fails", async () => {
    vi.useFakeTimers();
    const seen: Array<UpdaterState | null> = [];
    const live = platform();
    const load = vi
      .fn<() => Promise<UpdaterState>>()
      .mockRejectedValueOnce(new Error("restarting"))
      .mockResolvedValueOnce({ status: "downloaded", version: "1.0.53" });
    const stop = watchRemoteUpdater((s) => seen.push(s), load, live.value);
    live.sources[0].message({ kind: "hello", resumed: false, cursor: "a:1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    expect(live.sources[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.urls[1]).not.toContain("since=");
    live.sources[1].message({ kind: "hello", resumed: false, cursor: "a:1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ status: "downloaded", version: "1.0.53" }]);
    stop();
  });

  it("keeps a newer load over a stale one from a dropped stream", async () => {
    vi.useFakeTimers();
    const seen: Array<UpdaterState | null> = [];
    const live = platform();
    const resolvers: Array<(s: UpdaterState) => void> = [];
    const load = () => new Promise<UpdaterState>((done) => resolvers.push(done));
    const stop = watchRemoteUpdater((s) => seen.push(s), load, live.value);
    live.sources[0].message({ kind: "hello", resumed: false, cursor: "a:1" });
    live.sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(60_000);
    live.sources[1].message({ kind: "hello", resumed: false, cursor: "b:1" });
    resolvers[1]({ status: "downloaded", version: "1.0.53" });
    await vi.advanceTimersByTimeAsync(0);
    resolvers[0]({ status: "available", version: "1.0.53" });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ status: "downloaded", version: "1.0.53" }]);
    stop();
  });

  it("routes actions to the server when the preload bridge is absent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "installing" })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { ogb: undefined });
    await updaterActions().install();
    expect(fetchMock).toHaveBeenCalledWith("/api/update/install", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the preload bridge on desktop", () => {
    const bridge = { check: vi.fn(), download: vi.fn(), install: vi.fn(), onState: vi.fn() };
    vi.stubGlobal("window", { ogb: { updater: bridge } });
    expect(updaterActions()).toBe(bridge);
  });
});
