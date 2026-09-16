import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => {
  let onDataCb: ((data: string) => void) | null = null;
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
    open: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCb = cb;
      return { dispose: vi.fn() };
    }),
    __emitData(data: string) { onDataCb?.(data); },
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
import { TerminalWorkspace } from "./TerminalWorkspace";
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
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: bridge && (window as unknown as { __pick?: unknown }).__pick } });
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

it("does not open a shell while the overlay is hidden after remount", async () => {
  const open = vi.fn(async () => ({ id: "session-1", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  mountBridge(bridge, { id: "bot-hidden", name: "Hidden", cwd: null });
  await act(async () => root.render(createElement(TerminalWorkspace, { bot: { id: "bot-hidden", name: "Hidden", cwd: null }, visible: false, focusBlocked: false, onClose: vi.fn() })));
  expect(open).not.toHaveBeenCalled();
});

it("shows a neutral choose-folder state instead of throwing on needsFolder", async () => {
  const open = vi.fn(async () => ({ needsFolder: true as const, reason: "explicit-unavailable" }));
  const bridge: TerminalBridge = { open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
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
  const bridge: TerminalBridge = { open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
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
  const bridge: TerminalBridge = { open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
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
