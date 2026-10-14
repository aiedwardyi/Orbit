// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jumpWindowMessages, mergeForwardPage, useJumpWindow, useOlderMessages } from "./message-pages";
import type { Message } from "@/state/store";

const row = (i: number): Message => ({ id: `m${i}`, parentId: i ? `m${i - 1}` : null, at: i, role: "user", kind: "text", text: `row ${i};` });
const rows = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => row(start + i));

describe("mergeForwardPage", () => {
  it("appends only newer rows and dedupes both overlap and repeated ids", () => {
    expect(mergeForwardPage(rows(0, 4), [row(1), row(2), row(3), row(4), row(4), row(5)], "m3")).toEqual(rows(0, 6));
  });

  it("rejects a missing cursor instead of skipping a gap", () => {
    const held = rows(0, 4);
    expect(mergeForwardPage(held, rows(5, 8), "m3")).toBe(held);
  });

  it("reports no progress when the page ends at the cursor", () => {
    const held = rows(0, 4);
    expect(mergeForwardPage(held, rows(0, 4), "m3")).toBe(held);
  });
});

describe("jumpWindowMessages", () => {
  it("keeps the loaded active fork when a newer sibling appears in a forward page", () => {
    const held = [...rows(0, 3), { ...row(10), parentId: "m1" }];
    const loaded = [row(3), row(4)];
    expect(jumpWindowMessages(held, loaded, "m0", "m4").map((message) => message.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("keeps the target's ancestors and uses the newest child without an active fork", () => {
    const held = [...rows(0, 3), { ...row(10), parentId: "m1" }];
    expect(jumpWindowMessages(held, [], "m1", "missing").map((message) => message.id)).toEqual(["m0", "m1", "m10"]);
  });
});

describe("useJumpWindow forward paging", () => {
  it("cancels a pending lookup when returning to latest", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    let jump!: ReturnType<typeof useJumpWindow>;
    function Probe() {
      jump = useJumpWindow(vi.fn(), "a", "thread-a", rows(300, 500), "m499", undefined, 0);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => jump.open("m20"));
      expect(jump.pending).toBe(true);
      await act(async () => jump.close());
      expect(jump.pending).toBe(false);
      await act(async () => release(Response.json({ messages: rows(0, 200), hasMore: false })));
      expect(jump.messages).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

  it("joins the live head once after a single forward request with a deduped prefix", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("around=m20")
      ? Promise.resolve(Response.json({ messages: rows(0, 200), hasMore: false }))
      : new Promise<Response>((resolve) => { release = resolve; })));
    const dispatch = vi.fn();
    let jump!: ReturnType<typeof useJumpWindow>;
    function Probe() {
      jump = useJumpWindow(dispatch, "a", "thread-a", rows(250, 500), "m499", undefined, 0);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => jump.open("m20"));
      const beforeCommit = vi.fn();
      await act(async () => { jump.newer(beforeCommit); jump.newer(beforeCommit); });
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => release(Response.json({ messages: rows(100, 300), hasMore: true })));
      expect(beforeCommit).toHaveBeenCalledTimes(1);
      expect(beforeCommit.mock.calls[0]![0]).toEqual(rows(0, 500));
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "olderMessages", threadId: "thread-a", before: "m250", messages: rows(0, 250), hasMore: false });
      expect(jump.messages).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

  it("discards a forward page after leaving its view", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("around=m20")
      ? Promise.resolve(Response.json({ messages: rows(0, 200), hasMore: false }))
      : new Promise<Response>((resolve) => { release = resolve; })));
    const dispatch = vi.fn();
    let jump!: ReturnType<typeof useJumpWindow>;
    function Probe({ view }: { view: string }) {
      jump = useJumpWindow(dispatch, view, `thread-${view}`, rows(300, 500), "m499", undefined, 0);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Probe, { view: "a" })));
      await act(async () => jump.open("m20"));
      const beforeCommit = vi.fn();
      await act(async () => jump.newer(beforeCommit));
      await act(async () => root.render(createElement(Probe, { view: "b" })));
      await act(async () => release(Response.json({ messages: rows(100, 300), hasMore: true })));
      expect(beforeCommit).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(jump.messages).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
});

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
