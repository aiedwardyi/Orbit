// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot, ScrollText } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async () => {
  const actual = await vi.importActual<typeof import("@/state/store")>("@/state/store");
  return { ...actual, api: store.api };
});

import { I18nProvider } from "@/lib/i18n";
import { RemoteTerminalView, remotePaneHotkey, snapshotText } from "./RemoteTerminalView";
import { ProviderMark } from "./ProviderIcons";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"), "utf8");

afterEach(() => {
  store.api.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function renderView(visible = true, messages: Message[] = []) {
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada", messages }, visible, onClose }))),
  );
  return { host, root, onClose };
}

const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const composer = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type a command"]');
const sends = () => store.api.mock.calls.filter(([path]) => String(path).endsWith("/send"));
// submittedAgo is elapsed wall time, so only its presence is pinned.
const resumeBody = (sessionId: string, afterMessageId?: string) => expect.toSatisfy((body: string) => {
  const { submittedAgo, ...rest } = JSON.parse(body);
  return Number.isInteger(submittedAgo) && JSON.stringify(rest) === JSON.stringify({ sessionId, afterMessageId });
});

function typeLine(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(input: HTMLTextAreaElement, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, shiftKey, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query === "(pointer: coarse)" }));
}

const typingSnapshot = async (path: string) =>
  path.endsWith("/send") ? { screenText: "$ sent", sessionId: "s1", generation: 2 } : { screenText: "$", sessionId: "s1", generation: 2 };

describe("RemoteTerminalView", () => {
  it("renders recent text then the live screen with the cwd", async () => {
    store.api.mockResolvedValue({ screenText: "$ ls", recentText: "done", cwd: "C:\work", exited: false });
    const { host, root } = await renderView();
    expect(store.api).toHaveBeenCalledWith("/api/bots/bot-1/terminal");
    expect(host.querySelector("pre")?.textContent).toBe("done\n\n$ ls");
    expect(host.textContent).toContain("C:\work");
    await act(async () => root.unmount());
  });

  it("renders styled screen runs with palette colors", async () => {
    store.api.mockResolvedValue({
      screenText: "ok bar\n$",
      screenRuns: [[{ t: "ok", fg: 2, b: 1 }, { t: " " }, { t: "bar", bg: "#010203", u: 1, s: 1 }], [{ t: "$" }]],
      recentText: "done",
    });
    const { host, root } = await renderView();
    const pre = host.querySelector("pre")!;
    expect(pre.textContent).toBe("done\n\nok bar\n$");
    const [ok, , bar] = [...pre.querySelectorAll("span")];
    expect(ok.style.color).toMatch(/#4e9a06|rgb\(78, 154, 6\)/);
    expect(ok.style.fontWeight).toBe("600");
    expect(bar.style.backgroundColor).toMatch(/#010203|rgb\(1, 2, 3\)/);
    expect(bar.style.textDecoration).toBe("underline line-through");
    await act(async () => root.unmount());
  });

  it("renders plain text when the desktop sends no screen runs", async () => {
    store.api.mockResolvedValue({ screenText: "$ ls", recentText: "done" });
    const { host, root } = await renderView();
    expect(host.querySelector("pre")?.textContent).toBe("done\n\n$ ls");
    expect(host.querySelector("pre span")).toBeNull();
    await act(async () => root.unmount());
  });

  it("keeps pty-width rows unwrapped and scrolls sideways", async () => {
    store.api.mockResolvedValue({ screenText: "─".repeat(120), screenRuns: [[{ t: "─".repeat(120) }]] });
    const { host, root } = await renderView();
    const pre = host.querySelector("pre")!;
    expect(pre.className.split(" ")).toEqual(expect.arrayContaining(["whitespace-pre", "overflow-auto"]));
    expect(pre.className).not.toMatch(/pre-wrap|break-words/);
    await act(async () => root.unmount());
  });

  it("copies the full text to the clipboard", async () => {
    store.api.mockResolvedValue({ screenText: "$ ls", recentText: "done" });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, root } = await renderView();
    await act(async () => click(button(host, "Copy")));
    expect(writeText).toHaveBeenCalledWith("done\n\n$ ls");
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

  it("asks the host to open the main terminal from the no-terminal state", async () => {
    store.api.mockImplementation(async (path: string) =>
      path.endsWith("/start") ? { screenText: "PS>", sessionId: "s1", generation: 1, panes: [{ sessionId: "s1", main: true }] } : { state: "no-terminal", screenText: "", recentText: "" });
    const { host, root } = await renderView();
    try {
      const open = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Open terminal"))!;
      await act(async () => click(open));
      expect(store.api).toHaveBeenCalledWith("/api/bots/bot-1/terminal/start", { method: "POST" });
      expect(host.querySelector("pre")?.textContent).toBe("PS>");
      expect(composer(host)).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the no-terminal state and shows why when the host cannot open one", async () => {
    store.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/start")) throw new Error("Terminal folder is unavailable");
      return { state: "no-terminal", screenText: "", recentText: "" };
    });
    const { host, root } = await renderView();
    try {
      const open = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Open terminal"))!;
      await act(async () => click(open));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Terminal folder is unavailable");
      expect(open.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
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

  it("spins the refresh icon briefly on tap so the button reads as live", async () => {
    vi.useFakeTimers();
    store.api.mockResolvedValue({ screenText: "one" });
    const { host, root } = await renderView();
    await act(async () => click(button(host, "Refresh")));
    expect(button(host, "Refresh").disabled).toBe(true);
    expect(button(host, "Refresh").querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    await act(async () => vi.advanceTimersByTime(500));
    expect(button(host, "Refresh").disabled).toBe(false);
    expect(button(host, "Refresh").querySelector("svg")?.getAttribute("class")).not.toContain("animate-spin");
    await act(async () => root.unmount());
  });

  it("stops spinning after 5s when the refresh hangs", async () => {
    vi.useFakeTimers();
    store.api.mockResolvedValueOnce({ screenText: "one" }).mockReturnValue(new Promise(() => {}));
    const { host, root } = await renderView();
    try {
      await act(async () => click(button(host, "Refresh")));
      await act(async () => vi.advanceTimersByTime(4_900));
      expect(button(host, "Refresh").disabled).toBe(true);
      await act(async () => vi.advanceTimersByTime(100));
      expect(button(host, "Refresh").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("scrolls to the bottom on refresh even when the text is unchanged", async () => {
    store.api.mockResolvedValue({ screenText: "one" });
    const { host, root } = await renderView();
    const pre = host.querySelector("pre")!;
    Object.defineProperty(pre, "scrollHeight", { configurable: true, value: 800 });
    pre.scrollTop = 0;
    await act(async () => click(button(host, "Refresh")));
    expect(pre.scrollTop).toBe(800);
    await act(async () => root.unmount());
  });

  it("polls every 1s only while visible", async () => {
    vi.useFakeTimers();
    store.api.mockResolvedValue({ screenText: "one" });
    const { root } = await renderView(false);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(store.api).not.toHaveBeenCalled();
    await act(async () =>
      root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {} }))),
    );
    expect(store.api).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1_000));
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

  it.each([
    ["Claude Opus", "claudeAgent"], ["Codex Sol", "codex"], ["Grok 4.7", "grokAgent"],
    ["Muse 1.3", "museAgent"], ["script", "script"], ["Nova 2", null],
  ])("starts a %s pane tab with the header worker mark", async (model, provider) => {
    const sessionId = "aaaaaaaa-1111-4222-8333-944455556661";
    const messages: Message[] = [{ id: "launch", at: 1, role: "bot", kind: "launch", text: `Launched Worker | ${model} | high\nLabel: Worker | ${model} | high\nWorking folder: C:\\work\nSession: ${sessionId}` }];
    store.api.mockResolvedValue({ screenText: "$", panes: [{ sessionId: "main", main: true }, { sessionId, label: "Worker", main: false }] });
    const { host, root } = await renderView(true, messages);
    try {
      const [main, worker] = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      const mark = provider === "script" ? createElement(ScrollText, { size: 12, className: "text-ink-secondary", "aria-hidden": true })
        : provider ? createElement(ProviderMark, { driverKind: provider, size: 12 })
        : createElement(Bot, { size: 12, className: "text-ink-secondary", "aria-hidden": true });
      expect(worker.innerHTML).toContain(renderToStaticMarkup(mark));
      expect(worker.firstElementChild?.querySelector("svg")).not.toBeNull();
      expect(worker.textContent).toBe("Worker");
      expect(worker.querySelector("span.truncate")).not.toBeNull();
      expect(worker.className).toContain("min-w-[56px]");
      expect(host.querySelector('[role="tablist"]')?.className).toContain("overflow-x-auto");
      expect(main.textContent).toBe("Main");
      expect(main.querySelector("svg")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("starts a pane without a worker run with a plain bot mark", async () => {
    store.api.mockResolvedValue({ screenText: "$", panes: [{ sessionId: "main", main: true }, { sessionId: "worker", main: false }] });
    const { host, root } = await renderView();
    try {
      const worker = host.querySelectorAll('[role="tab"]')[1];
      expect(worker.querySelector(".lucide-bot")).not.toBeNull();
      expect(worker.querySelector(".lucide-scroll-text")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("takes the mark from the pane label when its launch is outside the loaded page", async () => {
    store.api.mockResolvedValue({ screenText: "$", panes: [{ sessionId: "main", main: true }, { sessionId: "worker", label: "Worker | Codex Sol | high", main: false }] });
    const { host, root } = await renderView();
    try {
      const worker = host.querySelectorAll('[role="tab"]')[1];
      expect(worker.innerHTML).toContain(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "codex", size: 12 })));
      expect(worker.querySelector(".lucide-bot")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
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
      await act(async () => vi.advanceTimersByTime(1_000));
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
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal?sessionId=one");
    await act(async () => root.unmount());
  });

  describe("with workers and no main", () => {
    type Pane = { sessionId: string; main: boolean; label?: string };
    const workers: Pane[] = [{ sessionId: "one", label: "one", main: false }, { sessionId: "two", label: "two", main: false }];
    const tabsOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const openButton = (host: HTMLElement) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Open terminal"))!;

    function mainServer(initial: Pane[] = workers) {
      const server = { panes: initial };
      store.api.mockImplementation(async (path: string) => {
        if (path.endsWith("/start")) {
          server.panes = [{ sessionId: "main", main: true }, ...server.panes];
          return { screenText: "PS>", sessionId: "main", generation: 1, panes: server.panes };
        }
        const id = new URLSearchParams(path.split("?")[1] ?? "").get("sessionId") ?? server.panes[0]?.sessionId;
        return { screenText: id === "main" ? "PS>" : `$ ${id}`, sessionId: id, generation: 1, panes: server.panes };
      });
      return server;
    }

    it("lists a dimmed Main tab first, even with one worker", async () => {
      mainServer([workers[0]]);
      const { host, root } = await renderView();
      try {
        const tabs = tabsOf(host);
        expect(tabs.map((tab) => tab.textContent)).toEqual(["Main", "one"]);
        expect(tabs[0].className).toContain("opacity-50");
        expect(tabs[1].className).not.toContain("opacity-50");
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(host.querySelector("pre")?.textContent).toBe("$ one");
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("shows the open panel with no worker screen or composer when Main is tapped", async () => {
      mainServer();
      const { host, root } = await renderView();
      try {
        await act(async () => click(tabsOf(host)[0]));
        expect(tabsOf(host)[0].getAttribute("aria-selected")).toBe("true");
        expect(host.textContent).toContain("No active terminal");
        expect(host.querySelector("pre")).toBeNull();
        expect(composer(host)).toBeNull();
        expect(button(host, "Copy").disabled).toBe(true);
        expect(openButton(host)).toBeDefined();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("starts main from the Main tab and selects it as the live first tab", async () => {
      mainServer();
      const { host, root } = await renderView();
      try {
        await act(async () => click(tabsOf(host)[0]));
        await act(async () => click(openButton(host)));
        expect(store.api).toHaveBeenCalledWith("/api/bots/bot-1/terminal/start", { method: "POST" });
        const tabs = tabsOf(host);
        expect(tabs.map((tab) => tab.textContent)).toEqual(["Main", "one", "two"]);
        expect(tabs[0].className).not.toContain("opacity-50");
        expect(tabs[0].getAttribute("aria-selected")).toBe("true");
        expect(host.querySelector("pre")?.textContent).toBe("PS>");
        expect(composer(host)).not.toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("returns to a worker tab from Main", async () => {
      mainServer();
      const { host, root } = await renderView();
      try {
        await act(async () => click(tabsOf(host)[0]));
        await act(async () => click(tabsOf(host)[2]));
        expect(host.querySelector("pre")?.textContent).toBe("$ two");
        expect(composer(host)).not.toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("keeps polling for main while the Main tab is open", async () => {
      vi.useFakeTimers();
      const server = mainServer();
      const { host, root } = await renderView();
      try {
        await act(async () => click(tabsOf(host)[0]));
        server.panes = [{ sessionId: "main", main: true }, ...workers];
        await act(async () => vi.advanceTimersByTime(1_000));
        expect(host.querySelector("pre")?.textContent).toBe("PS>");
        expect(tabsOf(host)[0].getAttribute("aria-selected")).toBe("true");
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("counts the Main tab first for Alt+n", async () => {
      mainServer();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const view = (paneHotkey: { n: number } | null) =>
        createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {}, paneHotkey }));
      try {
        await act(async () => root.render(view(null)));
        expect(tabsOf(host)[1].getAttribute("aria-selected")).toBe("true");
        await act(async () => root.render(view({ n: 1 })));
        expect(tabsOf(host)[0].getAttribute("aria-selected")).toBe("true");
        expect(host.textContent).toContain("No active terminal");
        await act(async () => root.render(view({ n: 3 })));
        expect(tabsOf(host)[2].getAttribute("aria-selected")).toBe("true");
        expect(host.querySelector("pre")?.textContent).toBe("$ two");
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  it("drops the Main tab when the last worker closes while it is open", async () => {
    vi.useFakeTimers();
    const server = paneServer([{ sessionId: "one", main: false }, { sessionId: "two", main: false }]);
    const { host, root } = await renderView();
    try {
      await act(async () => click(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]));
      server.panes = [];
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(host.textContent).toContain("No active terminal");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
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
      await act(async () => vi.advanceTimersByTime(1_000));
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
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(host.textContent).toContain("No active terminal");
      expect(host.querySelector("pre")).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () => vi.advanceTimersByTime(1_000));
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
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(host.textContent).toContain("No active terminal");
      server.panes = [{ sessionId: "main", main: true }];
      await act(async () => vi.advanceTimersByTime(1_000));
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

  it("sends a line with a trailing newline and replaces the snapshot", async () => {
    store.api.mockImplementation(async (path: string) =>
      path.endsWith("/send") ? { screenText: "$ ls\nREADME.md", sessionId: "s1", generation: 2 } : { screenText: "$", sessionId: "s1", generation: 2 });
    const { host, root } = await renderView();
    try {
      const input = composer(host)!;
      input.focus();
      await act(async () => typeLine(input, "ls"));
      await act(async () => click(button(host, "Send")));
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal/send", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", generation: 2, text: "ls\n" }),
      });
      expect(host.querySelector("pre")?.textContent).toBe("$ ls\nREADME.md");
      expect(input.value).toBe("");
      expect(document.activeElement).toBe(input);
      expect(input.autofocus).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps Enter and Shift+Enter as newlines on a phone", async () => {
    pointer(true);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      const input = composer(host)!;
      expect(input.enterKeyHint).not.toBe("send");
      await act(async () => typeLine(input, "first"));
      await act(async () => expect(pressEnter(input).defaultPrevented).toBe(false));
      await act(async () => expect(pressEnter(input, true).defaultPrevented).toBe(false));
      expect(sends()).toHaveLength(0);
      expect(input.value).toBe("first");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends a multi-line draft as one bracketed paste on the Send tap", async () => {
    pointer(true);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "fix the bug\nthen run tests"));
      await act(async () => click(button(host, "Send")));
      expect(sends()).toHaveLength(1);
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal/send", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", generation: 2, text: "fix the bug\nthen run tests", paste: true }),
      });
      expect(composer(host)!.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends on Enter and keeps Shift+Enter as a newline on desktop", async () => {
    pointer(false);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      const input = composer(host)!;
      await act(async () => typeLine(input, "ls"));
      await act(async () => expect(pressEnter(input, true).defaultPrevented).toBe(false));
      expect(sends()).toHaveLength(0);
      await act(async () => expect(pressEnter(input).defaultPrevented).toBe(true));
      expect(sends()).toHaveLength(1);
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal/send", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", generation: 2, text: "ls\n" }),
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("focuses the input when the view opens on a live terminal", async () => {
    pointer(false);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    const view = (visible: boolean) =>
      createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible, onClose: () => {} }));
    try {
      expect(document.activeElement).toBe(composer(host));
      composer(host)!.blur();
      await act(async () => root.render(view(false)));
      await act(async () => root.render(view(true)));
      expect(document.activeElement).toBe(composer(host));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("focuses the input after picking a pane tab", async () => {
    pointer(false);
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId: "worker", label: "Worker", main: false }];
    store.api.mockImplementation(async (path: string) => {
      const sessionId = path.includes("sessionId=worker") ? "worker" : "main";
      return { screenText: `$ ${sessionId}`, sessionId, generation: 1, panes };
    });
    const { host, root } = await renderView();
    try {
      const worker = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === "Worker")!;
      worker().focus();
      await act(async () => click(worker()));
      expect(host.querySelector("pre")?.textContent).toBe("$ worker");
      expect(document.activeElement).toBe(composer(host));
      worker().focus();
      await act(async () => click(worker()));
      expect(document.activeElement).toBe(composer(host));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["Send", "Up arrow"])("focuses the input after tapping %s", async (label) => {
    pointer(false);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      composer(host)!.blur();
      await act(async () => click(button(host, label)));
      expect(sends()).toHaveLength(1);
      expect(document.activeElement).toBe(composer(host));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("focuses the input on a screen click but not on one that selected text", async () => {
    pointer(false);
    store.api.mockResolvedValue({ screenText: "$ ls\nREADME.md", sessionId: "s1", generation: 2 });
    const { host, root } = await renderView();
    try {
      const pre = host.querySelector("pre")!;
      composer(host)!.blur();
      await act(async () => click(pre));
      expect(document.activeElement).toBe(composer(host));
      composer(host)!.blur();
      document.getSelection()!.selectAllChildren(pre);
      await act(async () => click(pre));
      expect(document.activeElement).not.toBe(composer(host));
      expect(document.getSelection()!.toString()).toBe("$ ls\nREADME.md");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("never focuses the input on a coarse pointer", async () => {
    pointer(true);
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      expect(document.activeElement).toBe(document.body);
      await act(async () => click(button(host, "Up arrow")));
      await act(async () => click(button(host, "Send")));
      await act(async () => click(host.querySelector("pre")!));
      expect(sends()).toHaveLength(2);
      expect(document.activeElement).toBe(document.body);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("posts the clear key from the Clear line button", async () => {
    store.api.mockImplementation(typingSnapshot);
    const { host, root } = await renderView();
    try {
      expect(button(host, "Clear line").textContent).toBe("Clear line");
      await act(async () => click(button(host, "Clear line")));
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal/send", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", generation: 2, key: "clear" }),
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("refreshes without resending on a stale generation", async () => {
    let generation = 2;
    store.api.mockImplementation(async (path: string) => {
      if (!path.endsWith("/send")) return { screenText: `$ gen ${generation}`, sessionId: "s1", generation };
      generation = 3;
      throw new Error("Terminal session is stale; take a fresh snapshot");
    });
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "pwd"));
      await act(async () => composer(host)!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(store.api.mock.calls.filter(([path]) => String(path).endsWith("/send"))).toHaveLength(1);
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal");
      expect(host.querySelector("pre")?.textContent).toBe("$ gen 3");
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Not sent: Terminal session is stale; take a fresh snapshot");
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(composer(host)!.value).toBe("pwd");
      expect(button(host, "Send").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([new TypeError("Load failed"), new Error("terminal bridge unreachable")])("warns the line may have run after %s", async (failure) => {
    let ran = false;
    store.api.mockImplementation(async (path: string) => {
      if (!path.endsWith("/send")) return { screenText: ran ? "$ make deploy" : "$", sessionId: "s1", generation: 2 };
      ran = true;
      throw failure;
    });
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "make deploy"));
      await act(async () => click(button(host, "Send")));
      expect(store.api.mock.calls.filter(([path]) => String(path).endsWith("/send"))).toHaveLength(1);
      expect(store.api).toHaveBeenLastCalledWith("/api/bots/bot-1/terminal");
      expect(host.querySelector("pre")?.textContent).toBe("$ make deploy");
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Send may have run. Check the screen before resending.");
      expect(composer(host)!.value).toBe("make deploy");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the server's reason for a rejected line", async () => {
    store.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/send")) throw new Error("control characters are not allowed");
      return { screenText: "$", sessionId: "s1", generation: 2 };
    });
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "ls"));
      await act(async () => click(button(host, "Send")));
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Not sent: control characters are not allowed");
      expect(store.api.mock.calls.filter(([path]) => !String(path).endsWith("/send"))).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps a line typed while the previous one was in flight", async () => {
    let resolve!: (value: { screenText: string; sessionId: string; generation: number }) => void;
    const pending = new Promise<{ screenText: string; sessionId: string; generation: number }>((done) => { resolve = done; });
    store.api.mockImplementation(async (path: string) => (path.endsWith("/send") ? pending : { screenText: "$", sessionId: "s1", generation: 2 }));
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "ls"));
      await act(async () => click(button(host, "Send")));
      await act(async () => typeLine(composer(host)!, "pwd"));
      await act(async () => resolve({ screenText: "$ ls", sessionId: "s1", generation: 2 }));
      expect(host.querySelector("pre")?.textContent).toBe("$ ls");
      expect(composer(host)!.value).toBe("pwd");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("disables Send while a line is in flight", async () => {
    let resolve!: (value: { screenText: string; sessionId: string; generation: number }) => void;
    const pending = new Promise<{ screenText: string; sessionId: string; generation: number }>((done) => { resolve = done; });
    store.api.mockImplementation(async (path: string) => (path.endsWith("/send") ? pending : { screenText: "$", sessionId: "s1", generation: 2 }));
    const { host, root } = await renderView();
    try {
      await act(async () => click(button(host, "Send")));
      expect(button(host, "Send").disabled).toBe(true);
      await act(async () => click(button(host, "Send")));
      expect(store.api.mock.calls.filter(([path]) => String(path).endsWith("/send"))).toHaveLength(1);
      await act(async () => resolve({ screenText: "$ ", sessionId: "s1", generation: 2 }));
      expect(button(host, "Send").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("hides the composer with no terminal or an exited pane", async () => {
    store.api.mockResolvedValue({ state: "no-terminal", screenText: "", recentText: "" });
    const first = await renderView();
    expect(composer(first.host)).toBeNull();
    await act(async () => first.root.unmount());
    store.api.mockResolvedValue({ screenText: "bye", sessionId: "s1", generation: 2, exited: true, exitCode: 0 });
    const second = await renderView();
    expect(composer(second.host)).toBeNull();
    await act(async () => second.root.unmount());
  });

  it("disables input and hides the old screen until the selected pane's snapshot arrives", async () => {
    vi.useFakeTimers();
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId: "worker", label: "Worker", main: false }];
    const main = { screenText: "main prompt", sessionId: "main", generation: 1, panes };
    store.api.mockImplementation((path: string) => (path.includes("?sessionId=worker") ? new Promise(() => {}) : Promise.resolve(main)));
    const { host, root } = await renderView();
    try {
      const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name)!;
      await act(async () => click(tab("Worker")));
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(tab("Worker").getAttribute("aria-selected")).toBe("true");
      expect([...host.querySelectorAll("button")].some((el) => el.textContent === "Enter")).toBe(false);
      expect(host.textContent).not.toContain("main prompt");
      expect(sends()).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("ignores a late snapshot for a pane that is no longer selected (A -> B -> A)", async () => {
    vi.useFakeTimers();
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId: "worker", label: "Worker", main: false }];
    const main = { screenText: "main prompt", sessionId: "main", generation: 1, panes };
    let resolveWorker!: (value: unknown) => void;
    store.api.mockImplementation((path: string) =>
      path.includes("?sessionId=worker") ? new Promise((resolve) => (resolveWorker = resolve)) : Promise.resolve(main),
    );
    const { host, root } = await renderView();
    try {
      const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name)!;
      await act(async () => click(tab("Worker")));
      await act(async () => click(tab("Main")));
      await act(async () => resolveWorker({ screenText: "worker prompt", sessionId: "worker", generation: 5, panes }));
      expect(tab("Main").getAttribute("aria-selected")).toBe("true");
      expect(host.textContent).not.toContain("worker prompt");
      await act(async () => vi.advanceTimersByTime(1_000));
      const enter = [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "Enter")!;
      await act(async () => click(enter));
      expect(JSON.parse(sends()[0][1].body)).toMatchObject({ sessionId: "main", generation: 1, key: "enter" });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("joins only the parts that have text", () => {
    expect(snapshotText({ screenText: "a" })).toBe("a");
    expect(snapshotText({ recentText: "b" })).toBe("b");
  });

  it("maps Alt+n onto the view's own pane order", () => {
    const workerFirst = [
      { sessionId: "worker", label: "Worker", main: false },
      { sessionId: "main", label: "Main", main: true },
    ];
    expect(remotePaneHotkey(workerFirst, 1)).toBe("worker");
    expect(remotePaneHotkey(workerFirst, 2)).toBeNull();
    expect(remotePaneHotkey(workerFirst, 9)).toBeUndefined();
  });

  it("selects that pane when Alt+n arrives", async () => {
    const panes = [
      { sessionId: "main", label: "Main", main: true },
      { sessionId: "worker", label: "Worker", main: false },
      { sessionId: "other", label: "Other", main: false },
    ];
    store.api.mockImplementation(async (path: string) => {
      const sessionId = String(path).includes("sessionId=other") ? "other" : String(path).includes("sessionId=worker") ? "worker" : "main";
      return { screenText: sessionId, sessionId, generation: 1, panes };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = (paneHotkey: { n: number } | null) =>
      createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {}, paneHotkey }));
    try {
      await act(async () => root.render(view(null)));
      const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name)!;
      expect(tab("Main").getAttribute("aria-selected")).toBe("true");
      await act(async () => root.render(view({ n: 3 })));
      expect(tab("Other").getAttribute("aria-selected")).toBe("true");
      await act(async () => root.render(view({ n: 1 })));
      expect(tab("Main").getAttribute("aria-selected")).toBe("true");
      await act(async () => root.render(view({ n: 9 })));
      expect(tab("Main").getAttribute("aria-selected")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("selects the focused pane when it is listed and stays on main otherwise", async () => {
    const panes = [
      { sessionId: "main", label: "Main", main: true },
      { sessionId: "worker", label: "Worker", main: false },
    ];
    store.api.mockImplementation(async (path: string) => {
      const sessionId = String(path).includes("sessionId=worker") ? "worker" : "main";
      return { screenText: sessionId, sessionId, generation: 1, panes };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = (paneFocus: { sessionId: string } | null) =>
      createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {}, paneFocus }));
    try {
      await act(async () => root.render(view({ sessionId: "worker" })));
      const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name)!;
      expect(tab("Worker").getAttribute("aria-selected")).toBe("true");
      await act(async () => root.render(view({ sessionId: "missing" })));
      expect(tab("Worker").getAttribute("aria-selected")).toBe("true");
      await act(async () => root.render(view({ sessionId: "main" })));
      expect(tab("Main").getAttribute("aria-selected")).toBe("true");
      expect(app.slice(app.indexOf("<RemoteTerminalView"), app.indexOf("<RemoteTerminalView") + 240)).toContain("paneFocus={paneFocus}");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("selects a focused pane once a later roster lists it", async () => {
    let panes = [{ sessionId: "main", label: "Main", main: true }];
    store.api.mockImplementation(async (path: string) => {
      const asked = String(path).includes("sessionId=worker");
      return { screenText: asked ? "worker" : "main", sessionId: asked ? "worker" : "main", generation: panes.length, panes };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = (paneFocus: { sessionId: string } | null) =>
      createElement(I18nProvider, null, createElement(RemoteTerminalView, { bot: { id: "bot-1", name: "Ada" }, visible: true, onClose: () => {}, paneFocus }));
    try {
      await act(async () => root.render(view({ sessionId: "worker" })));
      const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name);
      expect(host.querySelector('[role="tablist"]')).toBeNull();
      panes = [...panes, { sessionId: "worker", label: "Worker", main: false }];
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click());
      await vi.waitFor(() => expect(tab("Worker")?.getAttribute("aria-selected")).toBe("true"), { timeout: 2000 });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("offers the terminal button without the preload and picks the remote view there", () => {
    expect(app).toContain("onOpenTerminal={openTerminal}");
    expect(app).not.toContain("onOpenTerminal={window.ogb?.terminal ? openTerminal : undefined}");
    expect(app).toMatch(/window\.ogb\?\.terminal \? \(\s*<TerminalWorkspace[\s\S]*?\) : \(\s*<RemoteTerminalView/);
  });

  it.each(["follow up", "follow up\nthen test"])("notifies a successful typed worker follow-up %j", async (line) => {
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId: "worker", label: "Worker", main: false }];
    store.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume")) return { resumed: true };
      const worker = path.includes("sessionId=worker") || path.endsWith("/send");
      return { screenText: "$", sessionId: worker ? "worker" : "main", generation: 1, panes };
    });
    const { host, root } = await renderView();
    try {
      await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Worker")!));
      await act(async () => typeLine(composer(host)!, line));
      await act(async () => click(button(host, "Send")));
      const notifications = store.api.mock.calls.filter(([path]) => path.endsWith("/resume"));
      expect(notifications).toEqual([["/api/bots/bot-1/terminal/resume", {
        method: "POST", body: resumeBody("worker"),
      }]]);
      expect(sends()).toHaveLength(1);
      expect(composer(host)!.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not notify worker key buttons or typed input in the main terminal", async () => {
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId: "worker", label: "Worker", main: false }];
    let sessionId = "main";
    store.api.mockImplementation(async (path: string) => {
      if (!path.endsWith("/send")) sessionId = path.includes("sessionId=worker") ? "worker" : "main";
      return { screenText: "$", sessionId, generation: 1, panes };
    });
    const { host, root } = await renderView();
    try {
      await act(async () => typeLine(composer(host)!, "main command"));
      await act(async () => click(button(host, "Send")));
      await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Worker")!));
      const keys = [...host.querySelectorAll('[role="group"] button')];
      expect(keys).toHaveLength(5);
      for (const key of keys) await act(async () => click(key));
      expect(store.api.mock.calls.filter(([path]) => path.endsWith("/resume"))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("binds the phone notification to the worker row before terminal send settles", async () => {
    const sessionId = "0f3c9a1e-full";
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId, label: "Worker", main: false }];
    const messages: Message[] = [
      { id: "launch", at: 1, role: "bot", kind: "launch", text: `Launched WORKER\nLabel: WORKER\nSession: ${sessionId}` },
      { id: "settled", at: 2, role: "bot", kind: "note", text: "[pane 0f3c9a1e] [WORKER] from Ada (bot-1): DONE WORKER branch=x sha=y dirty=no" },
    ];
    let finish!: (snapshot: { sessionId: string; generation: number; panes: typeof panes }) => void;
    store.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/send")) return new Promise((resolve) => { finish = resolve; });
      if (path.endsWith("/resume")) return { resumed: true };
      return { screenText: "$", sessionId: path.includes(`sessionId=${sessionId}`) ? sessionId : "main", generation: 1, panes };
    });
    const { host, root, onClose } = await renderView(true, messages);
    try {
      await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Worker")!));
      await act(async () => typeLine(composer(host)!, "follow up"));
      await act(async () => click(button(host, "Send")));
      expect(store.api.mock.calls.filter(([path]) => path.endsWith("/resume"))).toEqual([]);
      const updated = [...messages, { ...messages[1], id: "reported-again", at: 3 }];
      await act(async () => root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, {
        bot: { id: "bot-1", name: "Ada", messages: updated }, visible: true, onClose,
      }))));
      await act(async () => { finish({ sessionId, generation: 1, panes }); });
      expect(store.api.mock.calls.filter(([path]) => path.endsWith("/resume"))).toEqual([["/api/bots/bot-1/terminal/resume", {
        method: "POST", body: resumeBody(sessionId, "settled"),
      }]]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("binds the phone notification to the active branch when a fork holds a later note", async () => {
    const sessionId = "0f3c9a1e-full";
    const panes = [{ sessionId: "main", label: "Main", main: true }, { sessionId, label: "Worker", main: false }];
    const messages: Message[] = [
      { id: "launch", at: 1, role: "bot", kind: "launch", parentId: null, text: `Launched WORKER\nLabel: WORKER\nSession: ${sessionId}` },
      { id: "settled", at: 2, role: "bot", kind: "note", parentId: "launch", text: "[pane 0f3c9a1e] [WORKER] from Ada (bot-1): DONE WORKER branch=x sha=y dirty=no" },
      { id: "inactive-later", at: 3, role: "bot", kind: "note", parentId: "launch", text: "[pane 0f3c9a1e] [WORKER] from Ada (bot-1): DONE WORKER branch=x sha=z dirty=no" },
    ];
    store.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume")) return { resumed: true };
      const worker = path.includes(`sessionId=${sessionId}`) || path.endsWith("/send");
      return { screenText: "$", sessionId: worker ? sessionId : "main", generation: 1, panes };
    });
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(I18nProvider, null, createElement(RemoteTerminalView, {
          bot: { id: "bot-1", name: "Ada", messages, activeLeafId: "settled" }, visible: true, onClose,
        }))),
      );
      await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Worker")!));
      await act(async () => typeLine(composer(host)!, "follow up"));
      await act(async () => click(button(host, "Send")));
      expect(store.api.mock.calls.filter(([path]) => path.endsWith("/resume"))).toEqual([["/api/bots/bot-1/terminal/resume", {
        method: "POST", body: resumeBody(sessionId, "settled"),
      }]]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
