// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onHoldReleased, reloadHeld } from "@/lib/reload-hold";
import { StoreProvider } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  onmessage: (() => void) | null = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountComposer() {
  let answer!: () => void;
  const uploaded = new Promise<void>((resolve) => (answer = resolve));
  const fetch = vi.fn(async (url: string) => {
    if (!String(url).includes("/api/attachments")) return Response.json({ error: "not in this test" }, { status: 404 });
    await uploaded;
    return Response.json({ path: "/tmp/shot.png", mime: "image/png", bytes: 3 });
  });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Composer, {}))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const uploads = () => fetch.mock.calls.filter(([url]) => String(url).includes("/api/attachments")).length;
  return { host, answer, uploads };
}

const image = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

const intakes: Array<[string, (host: HTMLElement) => void]> = [
  ["paste", (host) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [image()], getData: () => "" } });
    host.querySelector("textarea")!.dispatchEvent(event);
  }],
  ["pick", (host) => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [image()], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }],
  ["drop", () => {
    const event = new Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [image()] } });
    window.dispatchEvent(event);
  }],
];

describe("update reload during an upload", () => {
  it.each(intakes)("%s holds the reload until the chip is in the draft", async (_name, intake) => {
    const { host, answer, uploads } = await mountComposer();
    await act(async () => intake(host));
    await vi.waitFor(() => expect(uploads()).toBe(1));
    expect(reloadHeld()).toBe(true);
    let draftAtRelease: string | null = null;
    const stop = onHoldReleased(() => {
      draftAtRelease = localStorage.getItem("omb-draft-attachments");
    });
    await act(async () => answer());
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    stop();
    expect(draftAtRelease).toContain("/tmp/shot.png");
    expect(host.querySelector('[aria-label="Remove file"]')).not.toBeNull();
  });
});
