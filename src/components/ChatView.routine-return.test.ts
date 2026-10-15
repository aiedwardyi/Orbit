// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const engine = {
  instanceId: "muse",
  driverKind: "museAgent",
  displayName: "Meta Muse",
  snapshot: { state: "available" },
  models: { default: "muse-spark", options: [{ id: "muse-spark", label: "Meta Muse" }] },
};

const run = {
  id: "run-1",
  routineId: "routine-1",
  routineName: "Tool to try",
  botId: "py",
  runOn: "maus",
  scheduledFor: 1,
  status: "completed",
  manual: false,
  triggerSource: "schedule",
  sourceThreadId: "main-thread",
  threadId: "run-thread",
  createdAt: 1,
};

const python = (threadId: string) => ({
  id: "py",
  threadId,
  name: "Python",
  modelSelection: { instanceId: "muse", model: "muse-spark" },
  tasks: [
    { threadId: "run-thread", title: "Tool to try", createdAt: 3 },
    { threadId: "main-thread", title: "Python", createdAt: 1 },
  ],
  messages: [],
});

afterEach(() => {
  window.localStorage.removeItem("omb-onboarding-done");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountApp(threadId: string) {
  window.localStorage.setItem("omb-onboarding-done", "true");
  vi.stubGlobal("EventSource", FakeEventSource);
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots: [python(threadId)], groups: [] }));
    if (path === "/api/instances") return new Response(JSON.stringify({ instances: [engine] }));
    if (path === "/api/routines") return new Response(JSON.stringify({ routines: [], runs: [run] }));
    if (path === "/api/bots/py/tasks/main-thread") return new Response(JSON.stringify({ bot: python("main-thread") }));
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  return {
    host,
    fetchMock,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const backButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Back to chat");

describe("ChatView routine run thread", () => {
  it("shows a back bar on a run thread and switches to the chat it reports to", async () => {
    const { host, fetchMock, unmount } = await mountApp("run-thread");
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("You're viewing a run of Tool to try."));
      await act(async () => backButton(host)!.click());
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/bots/py/tasks/main-thread", expect.objectContaining({ method: "POST" })),
      );
      await vi.waitFor(() => expect(backButton(host)).toBeUndefined());
    } finally {
      await unmount();
    }
  });

  it("hides the back bar on a normal thread", async () => {
    const { host, fetchMock, unmount } = await mountApp("main-thread");
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/routines", expect.anything()));
      await vi.waitFor(() => expect(host.querySelector("textarea")).not.toBeNull());
      expect(host.textContent).not.toContain("You're viewing a run of");
      expect(backButton(host)).toBeUndefined();
    } finally {
      await unmount();
    }
  });
});
