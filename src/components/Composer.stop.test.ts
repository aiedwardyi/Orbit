import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    useStore: () => ({
      state: {
        acceptedSends: {},
        bots: [],
        composerFocusBotId: null,
        instances: [],
        pendingQueued: {},
      },
      dispatch,
    }),
  };
});

import { Composer } from "./Composer";
import type { Bot } from "@/state/store";

const bot: Bot = {
  id: "stopper", threadId: "stopper-thread", name: "Stopper", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: true, activity: "working",
  modelSelection: { instanceId: "claude", model: "claude" },
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function mount(subject: Bot) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Composer, { bot: subject })));
}

const stopButton = () => {
  const button = host!.querySelector('button[aria-label="Stop this turn"]');
  if (!(button instanceof HTMLElement)) throw new Error("stop button did not render");
  return button;
};

const interrupts = () => dispatch.mock.calls.filter(([action]) => action.type === "interrupt");

describe("composer stop", () => {
  it("shows stopping at once and sends one interrupt for repeat clicks", async () => {
    await mount(bot);
    for (let i = 0; i < 5; i++) await act(async () => stopButton().click());
    expect(interrupts()).toHaveLength(1);
    expect(stopButton().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps Stop live when the turn is still running after the interrupt settles", async () => {
    await mount(bot);
    await act(async () => stopButton().click());
    await act(async () => interrupts()[0]![0].onSettled());
    expect(stopButton().getAttribute("aria-busy")).toBe("false");
    await act(async () => stopButton().click());
    expect(interrupts()).toHaveLength(2);
  });
});
