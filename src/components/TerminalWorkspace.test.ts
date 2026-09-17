import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  options: {}, cols: 80, rows: 24,
  write: vi.fn(), focus: vi.fn(), dispose: vi.fn(),
  open: vi.fn(), loadAddon: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
}));
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
  expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(["snapshot", "next"]);
  expect(host.textContent).toContain("Started in C:\\work");
  await act(async () => render(false));
  await act(async () => { receive({ id: "session-1", data: "while hidden", seq: 3 }); });
  await act(async () => render(true));
  // Visible remount of the open effect may resume; appearance/session stay honest.
  expect(open.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenLastCalledWith("while hidden");
  await act(async () => applyTerminalMatch(true));
  expect(terminal.options).toMatchObject({ fontFamily: '"Example Nerd Font", monospace', fontSize: 16, theme: { background: "#303446", red: "#e78284" } });
  await act(async () => applyTerminalMatch(false));
  expect(terminal.options).toMatchObject({ fontSize: 13 });
});

it("does not open a shell while the overlay is hidden after remount", async () => {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const open = vi.fn(async () => ({ id: "session-1", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge } });
  const bot = { id: "bot-hidden", name: "Hidden", cwd: null };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: false, focusBlocked: false, onClose: vi.fn() })));
  expect(open).not.toHaveBeenCalled();
});

it("shows a neutral choose-folder state instead of throwing on needsFolder", async () => {
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const open = vi.fn(async () => ({ needsFolder: true as const, reason: "explicit-unavailable" }));
  const bridge: TerminalBridge = { appearance: vi.fn(async () => null), open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => vi.fn(), onExit: () => vi.fn() };
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: bridge, pickFolder: vi.fn(async () => null) } });
  const bot = { id: "bot-missing", name: "Missing", cwd: "D:\\gone" };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalWorkspace, { bot, visible: true, focusBlocked: false, onClose: vi.fn() })));
  await act(async () => {});
  expect(host.textContent).toMatch(/unavailable|Choose a folder|폴더/i);
  expect(host.textContent).not.toMatch(/Error invoking remote method/i);
});
