import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  track: () => undefined,
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        acceptedSends: {},
        bots: [],
        composerFocusBotId: null,
        instances: [],
        pendingQueued: {},
      },
      dispatch: () => undefined,
    }),
  };
});

import { Composer } from "./Composer";
import type { Message } from "@/state/store";

const replyMessage: Message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 0 };

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(replyTo: Message | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Composer, { replyTo }));
  });
  const textarea = host.querySelector("[data-orbit-composer]");
  if (!(textarea instanceof HTMLElement) || textarea.tagName !== "TEXTAREA") {
    throw new Error("composer input did not render");
  }
  return textarea;
}

describe("composer reply focus", () => {
  it("focuses the input when a reply target is selected", async () => {
    const textarea = await mount(null);
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage }));
    });

    expect(document.activeElement).toBe(textarea);
  });
});
