import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function mount(replyTo: Message | null, focusBlocked = false, locked = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Composer, { replyTo, focusBlocked, locked }));
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
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false }));
    });

    expect(document.activeElement).toBe(textarea);
  });

  // a failed send restores replyTo, which re-fires this long after the click
  it("leaves focus alone while a modal or the palette holds it", async () => {
    const textarea = await mount(null);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    inside.focus();

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false }));
    });

    expect(document.activeElement).toBe(inside);
    expect(document.activeElement).not.toBe(textarea);
    dialog.remove();
  });

  // room setup and a pending approval both disable the textarea, and a
  // disabled input cannot take focus
  it("focuses once the composer unlocks with the reply still selected", async () => {
    const textarea = await mount(replyMessage, false, true);
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false, locked: false }));
    });

    expect(document.activeElement).toBe(textarea);
  });

  it("leaves focus alone when the composer is focus-blocked", async () => {
    const textarea = await mount(null, true);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: true }));
    });

    expect(document.activeElement).not.toBe(textarea);
  });
});
