import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => {
  let onDataCb: ((data: string) => void) | null = null;
  let onBinaryCb: ((data: string) => void) | null = null;
  return {
    options: { disableStdin: true } as { disableStdin: boolean; fontFamily?: string; fontSize?: number; theme?: unknown },
    cols: 80,
    rows: 24,
    write: vi.fn((data: string, cb?: () => void) => {
      // Historical DA query in a replayed snapshot must emit an emulator reply.
      if (String(data).includes("\x1b[c") || String(data).includes("\x1b[0c")) {
        onDataCb?.("\x1b[?1;2c");
      }
      if (typeof cb === "function") queueMicrotask(cb);
    }),
    focus: vi.fn(),
    dispose: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCb = cb;
      return { dispose: vi.fn() };
    }),
    onBinary: vi.fn((cb: (data: string) => void) => {
      onBinaryCb = cb;
      return { dispose: vi.fn() };
    }),
    __emitData(data: string) { onDataCb?.(data); },
    __emitBinary(data: string) { onBinaryCb?.(data); },
  };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- The DOM harness has no canvas; the bridge event ordering remains under test.
vi.mock("@xterm/xterm", () => ({ Terminal: class { constructor() { return terminal; } } }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Terminal sizing needs a real browser and is covered by packaged QA.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Folder persist uses the shared store; keep this harness free of SSE.
vi.mock("@/state/store", async () => {
  const actual = await vi.importActual<typeof import("@/state/store")>("@/state/store");
  return {
    ...actual,
    useStore: () => ({ state: {}, dispatch: vi.fn() }),
    api: vi.fn(),
  };
});
import { TerminalWorkspace, folderBasename } from "./TerminalWorkspace";
import { applyTerminalMatch } from "@/lib/terminal-appearance";
import { api } from "@/state/store";

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
type TerminalBridge = NonNullable<NonNullable<Window["ogb"]>["terminal"]>;
type TerminalSnapshot = Extract<Awaited<ReturnType<TerminalBridge["open"]>>, { id: string }>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  delete window.ogb;
  vi.clearAllMocks();
  window.localStorage.removeItem("omb-terminal-match-profile");
});

function mountBridge(bridge: TerminalBridge, bot = { id: "bot-1", name: "Desk", cwd: "C:\\work" as string | null }) {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: undefined } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  return bot;
}

it("joins the snapshot to live output once and retains the renderer across visibility changes", async () => {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let resolveOpen!: (value: TerminalSnapshot) => void;
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  const unsubscribe = vi.fn();
  const open = vi.fn(() => new Promise<TerminalSnapshot>((resolve) => { resolveOpen = resolve; }));
  const appearance = vi.fn(async () => ({ profileName: "PowerShell", fontFamily: "Example Nerd Font", fontSize: 16, theme: { background: "#303446", red: "#e78284" } }));
  const bridge: TerminalBridge = { appearance, open, write: vi.fn(), resize: vi.fn(async () => {}), onData: (cb) => { receive = cb; return unsubscribe; }, onExit: () => unsubscribe };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge } });
  const bot = { id: "bot-1", name: "Desk", cwd: "C:\\work" };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (visible: boolean) => root.render(createElement(TerminalWorkspace, { bot, visible, focusBlocked: false, onClose: vi.fn() }));
  await act(async () => render(true));
  await act(async () => {
    receive({ id: "session-1", data: "already in snapshot", seq: 1 });
    receive({ id: "session-1", data: "next", seq: 2 });
    resolveOpen({ id: "session-1", cwd: "C:\\work", shell: "pwsh.exe", output: "snapshot", seq: 1, exitCode: null });
  });
  await act(async () => { await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["snapshot", "next"]);
  expect(host.textContent).toContain("work");
  expect(host.textContent).toContain("Restart");
  await act(async () => render(false));
  await act(async () => { receive({ id: "session-1", data: "while hidden", seq: 3 }); });
  await act(async () => render(true));
  expect(open.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenLastCalledWith("while hidden");
  await act(async () => applyTerminalMatch(true));
  expect(terminal.options).toMatchObject({ fontFamily: '"Example Nerd Font", monospace', fontSize: 16, theme: { background: "#303446", red: "#e78284" } });
  await act(async () => applyTerminalMatch(false));
  expect(terminal.options).toMatchObject({ fontSize: 13 });
});

it("changes only terminal font size on Ctrl-wheel", async () => {
  const open = vi.fn(async () => ({ id: "session-zoom", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  mountBridge(bridge);
  await act(async () => root.render(createElement(TerminalWorkspace, { bot: { id: "bot-zoom", name: "Zoom", cwd: "C:\\work" }, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => { await Promise.resolve(); });
  terminal.options.fontSize = 13;
  const pane = host.querySelector<HTMLElement>("[data-orbit-terminal]");
  if (!pane) throw new Error("terminal pane did not render");
  const target = pane.firstElementChild as HTMLElement;
  const zoomIn = new window.Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperties(zoomIn, { deltaY: { value: -120 }, ctrlKey: { value: true } });
  await act(async () => { target.dispatchEvent(zoomIn); });
  expect(terminal.options.fontSize).toBe(14);
  const zoomOut = new window.Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperties(zoomOut, { deltaY: { value: 120 }, ctrlKey: { value: true } });
  await act(async () => { target.dispatchEvent(zoomOut); });
  expect(terminal.options.fontSize).toBe(13);
});

it("does not open a shell while the overlay is hidden after remount", async () => {
  const open = vi.fn(async () => ({ id: "session-1", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  mountBridge(bridge, { id: "bot-hidden", name: "Hidden", cwd: null });
  await act(async () => root.render(createElement(TerminalWorkspace, { bot: { id: "bot-hidden", name: "Hidden", cwd: null }, visible: false, focusBlocked: false, onClose: vi.fn() })));
  expect(open).not.toHaveBeenCalled();
});

it("shows a neutral choose-folder state instead of throwing on needsFolder", async () => {
  const open = vi.fn(async () => ({ needsFolder: true as const, reason: "explicit-unavailable" }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  Object.defineProperty(window, "ogb", {
    configurable: true,
    value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) },
  });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const bot = { id: "bot-missing", name: "Missing", cwd: "D:\\gone" };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => {});
  expect(host.textContent).toMatch(/unavailable|Choose a folder|폴더/i);
  expect(host.textContent).not.toMatch(/Error invoking remote method/i);
});

it("does not write device-attribute replies from historical replay to the PTY", async () => {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const write = vi.fn(async () => {});
  const open = vi.fn(async () => ({
    id: "session-da",
    cwd: "C:\\work",
    shell: "pwsh.exe",
    output: "prompt\x1b[c more",
    seq: 4,
    exitCode: null,
  }));
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-da", name: "DA", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write).toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  // After replay completes, genuine live emulator replies must reach the PTY.
  await act(async () => { terminal.__emitData("\x1b[?1;2c"); });
  expect(write).toHaveBeenCalledWith("session-da", "\x1b[?1;2c");
});

it("forwards Enter to the PTY after a full-screen turn settles", async () => {
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  const write = vi.fn(async () => {});
  const open = vi.fn(async () => ({
    id: "session-tui",
    cwd: "C:\\work",
    shell: "pwsh.exe",
    output: "\x1b[?1049hprompt",
    seq: 1,
    exitCode: null as number | null,
  }));
  const bot = mountBridge({
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: () => vi.fn(),
  });
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot, visible: true, focusBlocked: false, onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.options.disableStdin).toBe(false);
  await act(async () => { terminal.__emitData("first\r"); });
  expect(write).toHaveBeenCalledWith("session-tui", "first\r");
  write.mockClear();
  await act(async () => {
    receive({ id: "session-tui", data: "\x1b[?2026h\x1b[5;1Hdone\x1b[?2026l", seq: 2 });
  });
  expect(terminal.options.disableStdin).toBe(false);
  const pane = host.querySelector<HTMLElement>("[data-orbit-terminal]");
  if (!pane) throw new Error("terminal pane did not render");
  await act(async () => {
    pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(write).toHaveBeenCalledWith("session-tui", "\r");
  await act(async () => { terminal.__emitData("second\r"); });
  expect(write).toHaveBeenCalledWith("session-tui", "second\r");
});

it("queues live output until historical replay finishes and preserves seq order", async () => {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let resolveOpen!: (value: TerminalSnapshot) => void;
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  let writeCb: (() => void) | undefined;
  terminal.write.mockImplementation((data: string, cb?: () => void) => {
    if (String(data) === "SNAP") {
      writeCb = cb;
      return;
    }
    if (typeof cb === "function") queueMicrotask(cb);
  });
  const open = vi.fn(() => new Promise<TerminalSnapshot>((resolve) => { resolveOpen = resolve; }));
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-q", name: "Queue", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => {
    resolveOpen({ id: "session-q", cwd: "C:\\work", shell: "pwsh.exe", output: "SNAP", seq: 1, exitCode: null });
  });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SNAP"]);
  await act(async () => {
    receive({ id: "session-q", data: "live-b", seq: 3 });
    receive({ id: "session-q", data: "live-a", seq: 2 });
  });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SNAP"]);
  await act(async () => { writeCb?.(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SNAP", "live-a", "live-b"]);
});

it("shows header folder and restart controls for a private workspace", async () => {
  const open = vi.fn(async () => ({ id: "session-p", cwd: "C:\\Users\\private", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  Object.defineProperty(window, "ogb", {
    configurable: true,
    value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) },
  });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-p", name: "Chief of Staff", cwd: null },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toMatch(/Private workspace/i);
  expect(host.textContent).toMatch(/Restart/i);
  expect(host.textContent).toContain("Chief of Staff");
});

it("persists a header folder choice without restarting a live session", async () => {
  const open = vi.fn(async () => ({ id: "session-f", cwd: "C:\\old", shell: "pwsh.exe", output: "hi", seq: 1, exitCode: null }));
  const pickFolder = vi.fn(async () => "C:\\AI Newsroom");
  vi.mocked(api).mockResolvedValue({ bot: { id: "bot-f", name: "News", cwd: "C:\\AI Newsroom" } });
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const bot = { id: "bot-f", name: "News", cwd: "C:\\old" };
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(open).toHaveBeenCalledTimes(1);
  const folderBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("old"));
  expect(folderBtn).toBeTruthy();
  await act(async () => { folderBtn!.click(); });
  await act(async () => { await Promise.resolve(); });
  expect(pickFolder).toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith("/api/bots/bot-f", expect.objectContaining({ method: "PATCH" }));
  expect(open).toHaveBeenCalledTimes(1);
});

it("folderBasename keeps root paths non-empty", () => {
  expect(folderBasename("/")).toBe("/");
  expect(folderBasename("///")).toBe("///");
  expect(folderBasename("\\")).toBe("\\");
  expect(folderBasename("C:\\")).toBe("C:");
  expect(folderBasename("/home/user")).toBe("user");
  expect(folderBasename("C:\\work\\orbit")).toBe("orbit");
});

it("same-id fallback preserves liveQueue events from the restart IPC gap", async () => {
  const snapshot = { id: "session-gap", cwd: "C:\\work", shell: "pwsh.exe", output: "SCROLLBACK", seq: 2, exitCode: null as number | null };
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  let resolveFallback!: (value: typeof snapshot) => void;
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    if (opts.restart) return { needsFolder: true as const, reason: "explicit-unavailable" };
    if (open.mock.calls.length === 1) return { ...snapshot };
    return new Promise<typeof snapshot>((resolve) => { resolveFallback = resolve; });
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-gap", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SCROLLBACK"]);
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // PTY output during restart:true / restart:false IPC gap — seq in (lastSeq=2, resumed.seq=4].
  await act(async () => {
    receive({ id: "session-gap", data: "GAP_3", seq: 3 });
    receive({ id: "session-gap", data: "GAP_4", seq: 4 });
  });
  await act(async () => {
    resolveFallback({ ...snapshot, seq: 4, output: "SCROLLBACK\nGAP_3\nGAP_4" });
    await Promise.resolve();
    await Promise.resolve();
  });
  // Same-id path must not re-dump scrollback, but must drain the gap (not drop via seq > snapshot.seq).
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SCROLLBACK", "GAP_3", "GAP_4"]);
});

it("fallback resume after failed restart does not rewrite xterm scrollback", async () => {
  const snapshot = { id: "session-same", cwd: "C:\\work", shell: "pwsh.exe", output: "SCROLLBACK", seq: 2, exitCode: null as number | null };
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    if (opts.restart) return { needsFolder: true as const, reason: "explicit-unavailable" };
    return { ...snapshot };
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-fb", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SCROLLBACK"]);
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  // restart:true -> needsFolder, then restart:false resumes same id -- must not dump SCROLLBACK again
  expect(open.mock.calls.some((call) => call[0]?.restart === true)).toBe(true);
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SCROLLBACK"]);
  expect(host.textContent).not.toMatch(/unavailable|Choose a folder/i);
  // Same-id skip path must restore replayComplete so live output is not stuck in liveQueue.
  await act(async () => { receive({ id: "session-same", data: "LIVE_AFTER_FALLBACK", seq: 3 }); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["SCROLLBACK", "LIVE_AFTER_FALLBACK"]);
  // finishAttach (resize + focus) must still run on the same-id path.
  expect(terminal.focus).toHaveBeenCalled();
});

it("does not flash needsFolder banner while restart fallback is pending", async () => {
  const snapshot = { id: "session-pending", cwd: "C:\\work", shell: "pwsh.exe", output: "SCROLLBACK", seq: 2, exitCode: null as number | null };
  let resolveFallback!: (value: typeof snapshot) => void;
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    if (opts.restart) return { needsFolder: true as const, reason: "explicit-unavailable" };
    if (open.mock.calls.length === 1) return { ...snapshot };
    return new Promise<typeof snapshot>((resolve) => { resolveFallback = resolve; });
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-pending", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // Fallback open is still pending — choose-folder banner must not flash yet.
  expect(host.textContent).not.toMatch(/unavailable|Choose a folder/i);
  await act(async () => { resolveFallback({ ...snapshot }); await Promise.resolve(); await Promise.resolve(); });
  expect(host.textContent).not.toMatch(/unavailable|Choose a folder/i);
});

it("new-id fallback attach uses current bot cwd, not stale launchProject", async () => {
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    if (opts.restart) return { needsFolder: true as const, reason: "explicit-unavailable" };
    if (open.mock.calls.length === 1) {
      return { id: "session-old", cwd: "C:\\old", shell: "pwsh.exe", output: "OLD", seq: 1, exitCode: null as number | null };
    }
    // Host GC'd the prior session — fallback returns a fresh id.
    return { id: "session-new", cwd: "C:\\new", shell: "pwsh.exe", output: "NEW", seq: 1, exitCode: null as number | null };
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (cwd: string) => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-stale", name: "Desk", cwd },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  }));
  await act(async () => render("C:\\old"));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["OLD"]);
  // Mid-flight cwd change: mismatch banner shows old launch folder.
  await act(async () => render("C:\\new"));
  expect(host.textContent).toMatch(/Terminal started in a different folder/i);
  expect(host.textContent).toContain("C:\\old");
  const restartHere = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Open terminal here"));
  expect(restartHere).toBeTruthy();
  await act(async () => { restartHere!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  // New-id fallback must set launchProject from expectedProject (current cwd), clearing the mismatch banner.
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["OLD", "NEW"]);
  expect(host.textContent).not.toMatch(/Terminal started in a different folder/i);
  expect(host.textContent).not.toContain("C:\\old");
});

it("uses host launch metadata after switching bots", async () => {
  const snapshotA: TerminalSnapshot = { id: "session-a", cwd: "C:\\old", shell: "pwsh.exe", output: "A", seq: 1, exitCode: null, launchProject: "C:\\old" };
  const snapshotB: TerminalSnapshot = { id: "session-b", cwd: "C:\\other", shell: "pwsh.exe", output: "B", seq: 1, exitCode: null, launchProject: "C:\\other" };
  const open = vi.fn(async (opts: { botId: string; projectCwd?: string | null }) => opts.botId === "bot-a" ? snapshotA : snapshotB);
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  mountBridge(bridge);
  const render = (bot: { id: string; name: string; cwd: string }) => root.render(createElement(TerminalWorkspace, {
    bot, visible: true, focusBlocked: false, onClose: vi.fn(),
  }));
  await act(async () => render({ id: "bot-a", name: "A", cwd: "C:\\old" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  terminal.write.mockClear();
  await act(async () => render({ id: "bot-b", name: "B", cwd: "C:\\other" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => render({ id: "bot-a", name: "A", cwd: "C:\\new" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(open.mock.calls.map(([opts]) => opts.projectCwd)).toEqual(["C:\\old", "C:\\other", "C:\\new"]);
  expect(host.textContent).toContain("Terminal started in a different folder");
  expect(host.textContent).toContain("C:\\old");
});

it("starts a new shell from an exited session via New shell", async () => {
  let exitHandler: ((event: { id: string; exitCode: number }) => void) | null = null;
  let openCount = 0;
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    openCount += 1;
    if (openCount === 1) {
      return { id: "session-dead", cwd: "C:\\work", shell: "pwsh.exe", output: "BEFORE_EXIT", seq: 1, exitCode: null as number | null };
    }
    expect(opts.restart).toBe(true);
    return { id: "session-fresh", cwd: "C:\\work", shell: "pwsh.exe", output: "AFTER_RESTART", seq: 1, exitCode: null as number | null };
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: (cb) => { exitHandler = cb; return vi.fn(); },
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-dead", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["BEFORE_EXIT"]);
  expect(exitHandler).toBeTruthy();
  const disposeBefore = terminal.dispose.mock.calls.length;
  await act(async () => { exitHandler!({ id: "session-dead", exitCode: 0 }); });
  expect(host.textContent).toMatch(/Shell exited|exited/i);
  const newShellBtn = [...host.querySelectorAll("button")].find((el) => /New shell|새 셸/i.test(el.textContent ?? ""));
  expect(newShellBtn).toBeTruthy();
  await act(async () => { newShellBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  // Must restart in place (restart:true) without remounting the xterm effect.
  expect(open.mock.calls.some((call) => call[0]?.restart === true)).toBe(true);
  expect(terminal.dispose.mock.calls.length).toBe(disposeBefore);
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["BEFORE_EXIT", "AFTER_RESTART"]);
  expect(host.textContent).not.toMatch(/Shell exited \(0\)|exited \(0\)/i);
});

it.each([null, 7])("retains replacement events before restart resolves with exit %s", async (exitCode) => {
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  let exit!: (event: { id: string; exitCode: number }) => void;
  let resolveRestart!: (snapshot: TerminalSnapshot) => void;
  const open = vi.fn(async () => {
    if (open.mock.calls.length === 1) {
      return { id: "old", cwd: "C:\\work", shell: "pwsh.exe", output: "OLD", seq: 10, exitCode: null };
    }
    return new Promise<TerminalSnapshot>((resolve) => { resolveRestart = resolve; });
  });
  const write = vi.fn(async () => {});
  const bot = mountBridge({
    appearance: vi.fn(async () => null), open, write, resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: (cb) => { exit = cb; return vi.fn(); },
  });
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot, visible: true, focusBlocked: false, onClose: vi.fn(),
  })));
  const restart = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restart).toBeTruthy();
  await act(async () => { restart!.click(); });
  const confirm = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirm).toBeTruthy();
  await act(async () => { confirm!.click(); });
  await act(async () => {
    receive({ id: "new", data: "SNAPSHOT", seq: 1 });
    receive({ id: "new", data: "GAP", seq: 2 });
    receive({ id: "old", data: "STALE", seq: 11 });
    exit({ id: "old", exitCode: 0 });
    if (exitCode !== null) exit({ id: "new", exitCode });
    terminal.__emitData("blocked\r");
  });
  expect(write).not.toHaveBeenCalled();
  await act(async () => {
    resolveRestart({ id: "new", cwd: "C:\\work", shell: "pwsh.exe", output: "SNAPSHOT", seq: 1, exitCode: null });
  });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["OLD", "SNAPSHOT", "GAP"]);
  expect(terminal.options.disableStdin).toBe(exitCode !== null);
  await act(async () => { terminal.__emitData("dir\r"); });
  if (exitCode === null) expect(write).toHaveBeenCalledWith("new", "dir\r");
  else {
    expect(write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("(7)");
  }
});

it("restores keyboard input forwarding when fallback restart IPC throws", async () => {
  const snapshot = { id: "session-fallback-err", cwd: "C:\\work", shell: "pwsh.exe", output: "READY", seq: 1, exitCode: null as number | null };
  const write = vi.fn(async () => {});
  const open = vi.fn(async (opts: { restart?: boolean }) => {
    if (open.mock.calls.length === 1) return { ...snapshot };
    if (opts.restart) return { needsFolder: true as const, reason: "explicit-unavailable" };
    throw new Error("IPC transport failure");
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-err", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(host.textContent).toMatch(/unavailable|Choose a folder/i);
  // Fallback restart failed, but preserved session must still forward keyboard input.
  await act(async () => { terminal.__emitData("ls\r"); });
  expect(write).toHaveBeenCalledWith("session-fallback-err", "ls\r");
});

it("preserves an exit received during snapshot replay", async () => {
  let exitHandler: ((event: { id: string; exitCode: number }) => void) | null = null;
  let writeCallback: (() => void) | undefined;
  terminal.write.mockImplementation((data: string, cb?: () => void) => {
    if (String(data) === "SNAPSHOT") {
      writeCallback = cb;
      return;
    }
    if (typeof cb === "function") queueMicrotask(cb);
  });
  const open = vi.fn(async () => ({ id: "session-exit", cwd: "C:\\work", shell: "pwsh.exe", output: "SNAPSHOT", seq: 1, exitCode: null as number | null }));
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: (cb) => { exitHandler = cb; return vi.fn(); },
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-exit", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(writeCallback).toBeTruthy();
  await act(async () => { exitHandler!({ id: "session-exit", exitCode: 7 }); });
  await act(async () => { writeCallback?.(); await Promise.resolve(); });
  expect(host.textContent).toMatch(/Shell exited \(7\)|exited \(7\)/i);
  expect(terminal.options.disableStdin).toBe(true);
});

it("restores replayComplete and drains gap events when openShell restart rejects on a live session", async () => {
  const snapshot = { id: "session-live-rej", cwd: "C:\\work", shell: "pwsh.exe", output: "LIVE_SNAP", seq: 1, exitCode: null as number | null };
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  let rejectRestart!: (error: Error) => void;
  const write = vi.fn(async () => {});
  const open = vi.fn(async (_opts: { restart?: boolean }) => {
    if (open.mock.calls.length === 1) return { ...snapshot };
    return new Promise<typeof snapshot>((_, reject) => { rejectRestart = reject; });
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-live-rej", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["LIVE_SNAP"]);
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); });
  // Event arrives during in-flight restart IPC.
  await act(async () => {
    receive({ id: "session-live-rej", data: "GAP_DATA", seq: 2 });
  });
  await act(async () => {
    rejectRestart(new Error("Restart IPC rejected"));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.textContent).toMatch(/Restart IPC rejected/i);
  // Queued gap event must be drained exactly once without replaying scrollback.
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["LIVE_SNAP", "GAP_DATA"]);
  // Stdin forwarding must be restored on live session.
  await act(async () => { terminal.__emitData("dir\r"); });
  expect(write).toHaveBeenCalledWith("session-live-rej", "dir\r");
  // Subsequent live output must forward immediately.
  await act(async () => {
    receive({ id: "session-live-rej", data: "AFTER_DATA", seq: 3 });
  });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["LIVE_SNAP", "GAP_DATA", "AFTER_DATA"]);
  expect(terminal.options.disableStdin).toBe(false);
});

it("never revives an exited session when openShell restart rejects", async () => {
  const snapshot = { id: "session-dead-rej", cwd: "C:\\work", shell: "pwsh.exe", output: "BEFORE_EXIT", seq: 1, exitCode: 5 as number | null };
  let rejectRestart!: (error: Error) => void;
  const write = vi.fn(async () => {});
  const open = vi.fn(async (_opts: { restart?: boolean }) => {
    if (open.mock.calls.length === 1) return { ...snapshot };
    return new Promise<typeof snapshot>((_, reject) => { rejectRestart = reject; });
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: () => vi.fn(),
    onExit: () => vi.fn(),
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-dead-rej", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(host.textContent).toMatch(/Shell exited \(5\)|exited \(5\)/i);
  expect(terminal.options.disableStdin).toBe(true);
  const restartBtn = [...host.querySelectorAll("button")].find((el) => /Restart|다시 시작/i.test(el.textContent ?? ""));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    rejectRestart(new Error("Spawn failed"));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.textContent).toMatch(/Spawn failed/i);
  // Exited session must remain exited and never accept stdin.
  expect(host.textContent).toMatch(/Shell exited \(5\)|exited \(5\)/i);
  expect(terminal.options.disableStdin).toBe(true);
  await act(async () => { terminal.__emitData("dir\r"); });
  expect(write).not.toHaveBeenCalled();
});

it("forwards binary mouse reports to the PTY", async () => {
  const write = vi.fn(async () => {});
  const open = vi.fn(async () => ({ id: "session-bin", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write, resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  const bot = mountBridge(bridge, { id: "bot-bin", name: "Bin", cwd: "C:\\work" });
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // X10 wheel report (non-UTF8 bytes) arrives via onBinary, not onData.
  await act(async () => { terminal.__emitBinary("\x1b[M\x60\x21\x10"); });
  expect(write).toHaveBeenCalledWith("session-bin", "\x1b[M\x60\x21\x10");
});

it("forces an app repaint after attaching an alt-screen snapshot", async () => {
  const resize = vi.fn(async () => {});
  const open = vi.fn(async () => ({ id: "session-alt", cwd: "C:\\work", shell: "pwsh.exe", output: "TUI", seq: 1, exitCode: null, alternate: true }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(async () => {}), resize, onData: () => vi.fn(), onExit: () => vi.fn() };
  const bot = mountBridge(bridge, { id: "bot-alt", name: "Alt", cwd: "C:\\work" });
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  // Size bounce (rows - 1, then rows) makes a diff-rendering TUI repaint from live state.
  expect(resize.mock.calls).toEqual([["session-alt", 80, 23], ["session-alt", 80, 24]]);
});

it("re-runs fit, refresh, and PTY sync when the terminal becomes visible again", async () => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  try {
    const resize = vi.fn(async () => {});
    const open = vi.fn(async () => ({ id: "session-vis", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
    const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(async () => {}), resize, onData: () => vi.fn(), onExit: () => vi.fn() };
    const bot = mountBridge(bridge, { id: "bot-vis", name: "Vis", cwd: "C:\\work" });
    const render = (visible: boolean) => root.render(createElement(TerminalWorkspace, { bot, visible, focusBlocked: false, onClose: vi.fn() }));
    await act(async () => render(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    resize.mockClear();
    terminal.refresh.mockClear();
    await act(async () => render(false));
    expect(resize).not.toHaveBeenCalled();
    await act(async () => render(true));
    // Overlay keeps layout size while hidden, so this path replaces the missing ResizeObserver event.
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(resize.mock.calls).toEqual([["session-vis", 80, 24]]);
  } finally {
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDesc);
  }
});

it("preserves exit received during a rejected restart attempt", async () => {
  const snapshot = { id: "session-dying-rej", cwd: "C:\\work", shell: "pwsh.exe", output: "BEFORE", seq: 1, exitCode: null as number | null };
  let receive!: (event: { id: string; data: string; seq: number }) => void;
  let exitHandler!: (event: { id: string; exitCode: number }) => void;
  let rejectRestart!: (error: Error) => void;
  const write = vi.fn(async () => {});
  const open = vi.fn(async (_opts: { restart?: boolean }) => {
    if (open.mock.calls.length === 1) return { ...snapshot };
    return new Promise<typeof snapshot>((_, reject) => { rejectRestart = reject; });
  });
  const bridge: TerminalBridge = {
    appearance: vi.fn(async () => null),
    open,
    write,
    resize: vi.fn(async () => {}),
    onData: (cb) => { receive = cb; return vi.fn(); },
    onExit: (cb) => { exitHandler = cb; return vi.fn(); },
  };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, {
    bot: { id: "bot-dying-rej", name: "Desk", cwd: "C:\\work" },
    visible: true,
    focusBlocked: false,
    onClose: vi.fn(),
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const restartBtn = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Restart"));
  expect(restartBtn).toBeTruthy();
  await act(async () => { restartBtn!.click(); });
  const confirmBtn = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Restart terminal");
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
  await act(async () => { await Promise.resolve(); });
  // Event and exit arrive while restart IPC is in flight.
  await act(async () => {
    receive({ id: "session-dying-rej", data: "FINAL_WORDS", seq: 2 });
    exitHandler({ id: "session-dying-rej", exitCode: 137 });
  });
  await act(async () => {
    rejectRestart(new Error("Restart failure"));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["BEFORE", "FINAL_WORDS"]);
  expect(host.textContent).toMatch(/Shell exited \(137\)|exited \(137\)/i);
  expect(terminal.options.disableStdin).toBe(true);
  await act(async () => { terminal.__emitData("dir\r"); });
  expect(write).not.toHaveBeenCalled();
});

it("does not submit Enter while IME composition is active", async () => {
  const write = vi.fn(async () => {});
  const open = vi.fn(async () => ({ id: "session-ime", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write, resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  const bot = mountBridge(bridge, { id: "bot-ime", name: "IME", cwd: "C:\\work" });
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const pane = host.querySelector<HTMLElement>("[data-orbit-terminal]");
  if (!pane) throw new Error("terminal pane did not render");
  const composingEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperties(composingEnter, { keyCode: { value: 229 }, which: { value: 229 } });
  await act(async () => { pane.dispatchEvent(composingEnter); });
  expect(write).not.toHaveBeenCalled();
  await act(async () => { pane.dispatchEvent(new Event("compositionstart", { bubbles: true })); });
  const afterStart = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => { pane.dispatchEvent(afterStart); });
  expect(write).not.toHaveBeenCalled();
  await act(async () => { pane.dispatchEvent(new Event("compositionend", { bubbles: true })); });
  await act(async () => { pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(write).toHaveBeenCalledWith("session-ime", "\r");
});
