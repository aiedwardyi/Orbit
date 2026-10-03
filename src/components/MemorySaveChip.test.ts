// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySaveChip } from "./MemorySaveChip";

const NOW = 1_800_000_000_000;

async function renderChip(at: number) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MemorySaveChip, { summary: "likes short replies", at })));
  return { host, root };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MemorySaveChip", () => {
  it("shows an earlier save as saved on mount, without replaying Saving to memory", async () => {
    const { host, root } = await renderChip(NOW - 60_000);
    try {
      expect(host.textContent).toContain("likes short replies");
      expect(host.textContent).not.toContain("Saving to memory");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers Saving to memory for a save that just landed", async () => {
    const { host, root } = await renderChip(NOW);
    try {
      expect(host.textContent).toContain("Saving to memory");
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.textContent).toContain("likes short replies");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
