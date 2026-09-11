// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  onmessage: (() => void) | null = null;
  close = vi.fn();
}

const block = Array.from({ length: 131 }, (_, i) => `line ${i + 1}`).join("\n");

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountComposer() {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Composer, {}))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const box = host.querySelector("textarea")!;
  const card = () => host.querySelector('[aria-label="Display pasted text in chat box"]');
  return {
    box,
    card,
    type: (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    paste: (text: string) =>
      act(async () => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } });
        box.dispatchEvent(event);
      }),
    display: () => act(async () => card()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))),
    undo: async () => {
      const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => box.dispatchEvent(event));
      return event;
    },
  };
}

describe("Composer paste undo", () => {
  it("puts the text and the paste card back on Ctrl+Z right after display", async () => {
    const composer = await mountComposer();
    await composer.type("hello");
    await composer.paste(block);
    await composer.display();
    expect(composer.box.value).toBe(`hello\n\n${block}`);
    expect(composer.card()).toBeNull();

    const undo = await composer.undo();
    expect(undo.defaultPrevented).toBe(true);
    expect(composer.box.value).toBe("hello");
    expect(composer.card()).not.toBeNull();
    expect(Object.values(JSON.parse(localStorage.getItem("omb-drafts") ?? "{}"))).toEqual(["hello"]);
    expect(localStorage.getItem("omb-draft-attachments")).toContain("line 131");
  });

  it("leaves native undo alone once the text changes after display", async () => {
    const composer = await mountComposer();
    await composer.paste(block);
    await composer.display();
    await composer.type(`${block}!`);
    await composer.type(block);

    const undo = await composer.undo();
    expect(undo.defaultPrevented).toBe(false);
    expect(composer.box.value).toBe(block);
    expect(composer.card()).toBeNull();
  });
});
