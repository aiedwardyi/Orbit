import "../components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnPresence } from "@/components/TurnPresence";
import type { Bot } from "@/state/store";
import { useNoReplySwitch } from "./no-reply-switch";

let root: Root;
let host: HTMLDivElement;
let control: ReturnType<typeof useNoReplySwitch> & { onRerunSettled?: () => void };
const bot: Bot = { id: "b1", threadId: "t1", name: "Test", title: "", description: "", color: "green", notifications: false, unread: false, modelSelection: { instanceId: "test", model: "test" }, messages: [] };

function Probe({ userId, busy, signal }: { userId: string; busy: boolean; signal: boolean }) {
  control = useNoReplySwitch({ ...bot, busy }, userId, signal);
  return createElement(TurnPresence, { avatar: null, visible: control.active || busy || signal, label: "Working" });
}

async function render(userId = "u1", busy = false, signal = false) {
  await act(async () => root.render(createElement(Probe, { userId, busy, signal })));
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("no reply switch transition", () => {
  it.each(["busy", "signal"])("clears permanently when the fork starts with %s", async (start) => {
    await render();
    const settled = control.onRerunSettled;
    await act(async () => control.onSwitching("saving"));
    expect(control.active).toBe(true);
    await act(async () => control.onSwitching("rerunning"));
    await render("u2", start === "busy", start === "signal");
    expect(control.active).toBe(false);
    await act(async () => settled?.());
    await render("u2");
    expect(control.active).toBe(false);
    await act(async () => vi.advanceTimersByTime(300));
    expect(host.querySelector(".turn-presence")).toBeNull();
    await render("u3", true, true);
    await render("u3");
    expect(control.active).toBe(false);
  });

  it("holds the fork-to-start gap, then clears a rerun that ended before busy was seen", async () => {
    await render();
    const settled = control.onRerunSettled;
    await act(async () => control.onSwitching("saving"));
    await act(async () => control.onSwitching("rerunning"));
    await render("u2");
    expect(control.active).toBe(true);
    expect(host.querySelector(".thinking-shimmer")).not.toBeNull();
    await act(async () => settled?.());
    expect(control.active).toBe(false);
    await act(async () => vi.advanceTimersByTime(300));
    expect(host.querySelector(".turn-presence")).toBeNull();
  });
});
