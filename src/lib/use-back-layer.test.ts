import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBackLayer } from "./use-back-layer";

let host: HTMLDivElement;
let root: Root;
let events: WindowEventMap["orbit:back-layer"][];
const record = (event: WindowEventMap["orbit:back-layer"]) => events.push(event);

function Popup({ open, close }: { open: boolean; close: () => void }) {
  useBackLayer(open, close);
  return null;
}

beforeEach(() => {
  events = [];
  window.addEventListener("orbit:back-layer", record);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.removeEventListener("orbit:back-layer", record);
});

describe("useBackLayer", () => {
  it("keeps the entry while callbacks change and drops it when closed", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    await act(async () => root.render(createElement(Popup, { open: true, close: first })));
    const layer = events[0].detail;
    await act(async () => root.render(createElement(Popup, { open: true, close: latest })));
    expect(events).toHaveLength(1);
    layer.close!();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(Popup, { open: false, close: latest })));
    expect(events.map((event) => event.detail)).toEqual([layer, { key: layer.key }]);
  });

  it("drops the entry when the popup unmounts", async () => {
    await act(async () => root.render(createElement(Popup, { open: true, close: vi.fn() })));
    const { key } = events[0].detail;
    await act(async () => root.render(null));
    expect(events[1].detail).toEqual({ key });
  });

  it("does not register in the desktop app", async () => {
    window.ogb = {} as NonNullable<typeof window.ogb>;
    try {
      await act(async () => root.render(createElement(Popup, { open: true, close: vi.fn() })));
      expect(events).toHaveLength(0);
    } finally {
      window.ogb = undefined;
    }
  });
});
