// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

import { I18nProvider } from "@/lib/i18n";
import { RemoteTerminalView, snapshotText } from "./RemoteTerminalView";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"), "utf8");

afterEach(() => {
  store.api.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function renderView(visible = true) {
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible, onClose }))),
  );
  return { host, root, onClose };
}

const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("RemoteTerminalView", () => {
  it("renders the screen then recent text with the cwd", async () => {
    store.api.mockResolvedValue({ screenText: "$ ls", recentText: "done", cwd: "C:\work", exited: false });
    const { host, root } = await renderView();
    expect(store.api).toHaveBeenCalledWith("/api/bots/bot-1/terminal");
    expect(host.querySelector("pre")?.textContent).toBe("$ ls\n\ndone");
    expect(host.textContent).toContain("C:\work");
    await act(async () => root.unmount());
  });

  it("copies the full text to the clipboard", async () => {
    store.api.mockResolvedValue({ screenText: "$ ls", recentText: "done" });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, root } = await renderView();
    await act(async () => click(button(host, "Copy")));
    expect(writeText).toHaveBeenCalledWith("$ ls\n\ndone");
    await act(async () => root.unmount());
  });

  it("shows the no-terminal state and disables copy", async () => {
    store.api.mockResolvedValue({ state: "no-terminal", screenText: "", recentText: "" });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("No active terminal");
    expect(host.querySelector("pre")).toBeNull();
    expect(button(host, "Copy").disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("closes and refreshes on tap", async () => {
    store.api.mockResolvedValue({ screenText: "one" });
    const { host, root, onClose } = await renderView();
    await act(async () => click(button(host, "Refresh")));
    expect(store.api).toHaveBeenCalledTimes(2);
    click(button(host, "Close terminal"));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("polls every 3s only while visible", async () => {
    vi.useFakeTimers();
    store.api.mockResolvedValue({ screenText: "one" });
    const { root } = await renderView(false);
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(store.api).not.toHaveBeenCalled();
    await act(async () =>
      root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {} }))),
    );
    expect(store.api).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(store.api).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("renders a tab strip with labels for each pane", async () => {
    store.api.mockResolvedValue({
      screenText: "$ ls",
      cwd: "C:\\main",
      panes: [
        { sessionId: "main", label: null, cwd: "C:\\main", main: true, exited: false },
        { sessionId: "worker", label: null, cwd: "C:\\work\\build", main: false, exited: false },
      ],
    });
    const { host, root } = await renderView();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toBe("Main");
    expect(tabs[1].textContent).toBe("build");
    await act(async () => root.unmount());
  });

  it("does not render a tab strip with only a main pane", async () => {
    store.api.mockResolvedValue({
      screenText: "$ ls",
      panes: [{ sessionId: "main", label: null, main: true, exited: false }],
    });
    const { host, root } = await renderView();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
    await act(async () => root.unmount());
  });

  it("switches the fetched URL and rendered text when a tab is selected", async () => {
    const panes = [
      { sessionId: "main", label: null, main: true, exited: false },
      { sessionId: "worker", label: "build", main: false, exited: false },
    ];
    store.api.mockImplementation(async (path: string) => ({
      screenText: path.includes("sessionId=worker") ? "$ npm run build" : "$ ls",
      panes,
    }));
    const { host, root } = await renderView();
    expect(host.querySelector("pre")?.textContent).toBe("$ ls");
    const worker = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => click(worker));
    expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal?sessionId=worker");
    expect(host.querySelector("pre")?.textContent).toBe("$ npm run build");
    await act(async () => root.unmount());
  });

  it("ignores a previous pane's response after switching tabs", async () => {
    const panes = [
      { sessionId: "main", main: true },
      { sessionId: "worker", main: false },
    ];
    let resolve!: (value: { screenText: string; panes: typeof panes }) => void;
    const pending = new Promise<{ screenText: string; panes: typeof panes }>((done) => { resolve = done; });
    store.api.mockResolvedValueOnce({ screenText: "main", panes }).mockReturnValueOnce(pending)
      .mockResolvedValue({ screenText: "worker", panes });
    const { host, root } = await renderView();
    try {
      await act(async () => click(button(host, "Refresh")));
      await act(async () => click(host.querySelectorAll('[role="tab"]')[1]!));
      expect(host.querySelector("pre")?.textContent).toBe("worker");
      await act(async () => resolve({ screenText: "stale main", panes }));
      expect(host.querySelector("pre")?.textContent).toBe("worker");
      expect(host.querySelectorAll('[role="tab"]')[1]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("ignores a closed pane's late error after selecting another pane", async () => {
    const panes = [
      { sessionId: "main", main: true },
      { sessionId: "one", main: false },
      { sessionId: "two", main: false },
    ];
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    store.api.mockImplementation(async (path: string) => {
      if (path.includes("sessionId=one")) return pending;
      return { screenText: path.includes("sessionId=two") ? "two" : "main", panes };
    });
    const { host, root } = await renderView();
    try {
      await act(async () => click(host.querySelectorAll('[role="tab"]')[1]!));
      await act(async () => click(host.querySelectorAll('[role="tab"]')[2]!));
      expect(host.querySelector("pre")?.textContent).toBe("two");
      await act(async () => reject(new Error("Unknown terminal")));
      expect(host.querySelector("pre")?.textContent).toBe("two");
      expect(host.querySelectorAll('[role="tab"]')[2]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("renders a slow poll while the next refresh is still pending", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { screenText: string }) => void;
    const pending = new Promise<{ screenText: string }>((done) => { resolve = done; });
    store.api.mockReturnValueOnce(pending).mockReturnValue(new Promise(() => {}));
    const { host, root } = await renderView();
    try {
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(store.api).toHaveBeenCalledTimes(2);
      await act(async () => resolve({ screenText: "slow response" }));
      expect(host.querySelector("pre")?.textContent).toBe("slow response");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("dims an exited pane's tab", async () => {
    store.api.mockResolvedValue({
      screenText: "$ ls",
      panes: [
        { sessionId: "main", label: null, main: true, exited: false },
        { sessionId: "worker", label: "build", main: false, exited: true },
      ],
    });
    const { host, root } = await renderView();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].className).not.toContain("opacity-50");
    expect(tabs[1].className).toContain("opacity-50");
    await act(async () => root.unmount());
  });

  it("selects the first pane when the roster has no Main pane", async () => {
    const panes = [
      { sessionId: "one", label: "one", main: false, exited: false },
      { sessionId: "two", label: "two", main: false, exited: false },
    ];
    store.api.mockResolvedValue({ screenText: "$ ls", panes });
    const { host, root } = await renderView();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal?sessionId=one");
    await act(async () => root.unmount());
  });

  function paneServer(initial: Array<{ sessionId: string; main: boolean }>) {
    const server = { panes: initial };
    store.api.mockImplementation(async (path: string) => {
      const id = new URLSearchParams(path.split("?")[1] ?? "").get("sessionId");
      if (id && !server.panes.some((pane) => pane.sessionId === id)) throw new Error("Unknown terminal");
      const pane = id ?? server.panes.find((candidate) => candidate.main)?.sessionId;
      return pane ? { screenText: `$ ${pane}`, panes: server.panes } : { state: "no-terminal", panes: server.panes };
    });
    return server;
  }

  it("recovers to the remaining pane when the fallback pane closes", async () => {
    vi.useFakeTimers();
    const server = paneServer([{ sessionId: "one", main: false }, { sessionId: "two", main: false }]);
    const { host, root } = await renderView();
    try {
      expect(host.querySelector("pre")?.textContent).toBe("$ one");
      server.panes = [{ sessionId: "two", main: false }];
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal?sessionId=two");
      expect(host.querySelector("pre")?.textContent).toBe("$ two");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("shows the no-terminal state when the fallback pane was the last one", async () => {
    vi.useFakeTimers();
    const server = paneServer([{ sessionId: "one", main: false }]);
    const { host, root } = await renderView();
    try {
      expect(host.querySelector("pre")?.textContent).toBe("$ one");
      server.panes = [];
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(host.textContent).toContain("No active terminal");
      expect(host.querySelector("pre")).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("switches to a Main pane that appears after the fallback pane closes", async () => {
    vi.useFakeTimers();
    const server = paneServer([{ sessionId: "one", main: false }]);
    const { host, root } = await renderView();
    try {
      server.panes = [];
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(host.textContent).toContain("No active terminal");
      server.panes = [{ sessionId: "main", main: true }];
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal");
      expect(host.querySelector("pre")?.textContent).toBe("$ main");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("falls back to the main pane when the selected pane closes", async () => {
    store.api.mockImplementation(async (path: string) => {
      if (path.includes("sessionId=worker")) throw new Error("Unknown terminal");
      return {
        screenText: "$ ls",
        panes: [
          { sessionId: "main", label: null, main: true, exited: false },
          { sessionId: "worker", label: "build", main: false, exited: false },
        ],
      };
    });
    const { host, root } = await renderView();
    const worker = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => click(worker));
    await act(async () => {});
    expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal");
    await act(async () => root.unmount());
  });

  it("joins only the parts that have text", () => {
    expect(snapshotText({ screenText: "a" })).toBe("a");
    expect(snapshotText({ recentText: "b" })).toBe("b");
  });

  it("offers the terminal button without the preload and picks the remote view there", () => {
    expect(app).toContain("onOpenTerminal={openTerminal}");
    expect(app).not.toContain("onOpenTerminal={window.ogb?.terminal ? openTerminal : undefined}");
    expect(app).toMatch(/window\.ogb\?\.terminal \? \(\s*<TerminalWorkspace[\s\S]*?\) : \(\s*<RemoteTerminalView/);
  });
});
