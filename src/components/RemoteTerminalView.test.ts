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
