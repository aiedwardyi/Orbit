import "./ProfileFields.test-dom.ts";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";
import { DockedPresence, TurnPresence } from "./TurnPresence";

const selection = { instanceId: "gemini", model: "gemini-3.8-flash-high", effort: "high" as const };
const next = { instanceId: "codex", model: "gpt-6.1-sol", effort: "high", mode: "pinned" as const };
const text = 'Check this\n\n<attached-image path="/tmp/photo.png" />\n\n<attached-file path="/tmp/notes.txt" name="notes.txt" size="42" />\n\n<pasted-text index="3">\nkeep this\n</pasted-text>';
const instances: InstanceInfo[] = [selection, next].map((pick) => ({
  instanceId: pick.instanceId, driverKind: pick.instanceId === "codex" ? "codex" : "antigravityAgent", displayName: pick.instanceId,
  snapshot: { state: "available", authenticated: true },
  models: { default: pick.model, options: [{ id: pick.model, label: pick.model }] },
  capabilities: { effortLevels: ["low", "high"] },
}));
let bot: Bot;
let root: Root;
let host: HTMLDivElement;
let hint = true;
let docked = false;
let minutes = 2;
let stop: "ok" | "failed" | "unsettled" | "ended" = "ok";
let queued = false;
const control = createRef<() => void>();
const transitions = vi.fn();
const dispatch = vi.fn((action: any) => {
  if (action.type === "setModel") {
    bot = { ...bot, ...(bot.busy ? { pendingModelSelection: action.selection } : { modelSelection: action.selection }) };
    action.onApplied?.(bot);
  }
  if (action.type === "interrupt") {
    if (stop === "unsettled") return;
    if (stop === "failed") return action.onFailure?.();
    bot = { ...bot, busy: false, modelSelection: bot.pendingModelSelection!, pendingModelSelection: null };
    action.onStopped?.({ stopped: stop !== "ended", returned: queued ? [{}] : [] });
  }
  if (action.type === "editMessage") action.onSettled?.();
});

async function render() {
  const props = { avatar: null, label: `Gemini hasn't replied in ${minutes} min`, wrap: hint, quiet: minutes > 2, onSwitch: hint ? () => control.current?.() : undefined };
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(ModelPickerControl, { bot, switchControl: control, onSwitching: transitions, store: { state: { instances, selectedId: bot.id }, dispatch, refreshInstances: async () => {} } }),
    docked ? createElement(DockedPresence, { ...props, live: true }) : createElement(TurnPresence, { ...props, visible: true }),
  )));
}

async function open() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Switch model"]');
  expect(button).not.toBeNull();
  button!.focus();
  await act(async () => button!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
}

async function save(different = true) {
  if (different) await act(async () => document.querySelector<HTMLButtonElement>('[data-model-cell="gpt-6.1-sol"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".model-cross-footer button")][0]!.click());
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference("en");
  bot = { id: "b1", threadId: "t1", name: "Test", title: "", description: "", color: "green", notifications: false, unread: false, busy: true, modelSelection: selection, messages: [{ id: "u1", role: "user", kind: "text", text, at: 1 }] };
  hint = true;
  docked = false;
  minutes = 2;
  queued = false;
  stop = "ok";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  dispatch.mockClear();
  transitions.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  persistPreference("en");
  vi.unstubAllGlobals();
});

describe("switch from no reply", () => {
  it.each([false, true])("exists only with the hint, docked %s", async (dock) => {
    docked = dock;
    hint = false;
    await render();
    expect(host.querySelector('[aria-label="Switch model"]')).toBeNull();
    hint = true;
    await render();
    await open();
    expect(document.querySelector('[data-model-cell="gemini-3.8-flash-high"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["cancel", "escape", "same"])("%s leaves the waiting turn untouched and restores focus", async (choice) => {
    await render();
    const button = host.querySelector('[aria-label="Switch model"]');
    await open();
    if (choice === "same") await save(false);
    else await act(async () => {
      if (choice === "escape") document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else document.querySelector<HTMLButtonElement>(".model-cross-header button")!.click();
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    expect(bot.busy).toBe(true);
  });

  it("stops once, then forks the complete last message on the applied pick", async () => {
    await render();
    await open();
    await save();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel", "interrupt", "editMessage"]);
    expect(dispatch.mock.calls[2][0]).toMatchObject({ botId: "b1", messageId: "u1", text });
    expect(bot.modelSelection).toMatchObject(next);
    expect(transitions.mock.calls.map(([stage]) => stage)).toEqual(["saving", "rerunning"]);
  });

  it("does nothing when the saved effort is the model's existing default", async () => {
    bot = { ...bot, modelSelection: { ...next, effort: undefined } };
    await render();
    await open();
    await save(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("switches effort alone with one stop and one rerun", async () => {
    bot = { ...bot, modelSelection: { ...next, effort: "high" } };
    await render();
    await open();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-picker-effort="low"]')!.click());
    await save(false);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel", "interrupt", "editMessage"]);
    expect(bot.modelSelection.effort).toBe("low");
  });

  it("treats a turn that ended before Save as a plain pick", async () => {
    await render();
    await open();
    bot = { ...bot, busy: false };
    await render();
    await save();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel"]);
    expect(bot.modelSelection).toMatchObject(next);
  });

  it.each(["failed", "unsettled"] as const)("does not rerun after a %s stop and leaves the pick pending", async (outcome) => {
    stop = outcome;
    await render();
    await open();
    await save();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel", "interrupt"]);
    expect(bot.modelSelection).toEqual(selection);
    expect(bot.pendingModelSelection).toMatchObject(next);
  });

  it("does not rerun if the turn ended before interrupt reached the server", async () => {
    stop = "ended";
    await render();
    await open();
    await save();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel", "interrupt"]);
  });

  it("returns queued sends through Stop without an extra rerun", async () => {
    queued = true;
    await render();
    await open();
    await save();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["setModel", "interrupt"]);
  });

  it("keeps Switch mounted and focused across minute updates", async () => {
    await render();
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Switch model"]');
    expect(button).not.toBeNull();
    button!.focus();
    minutes = 3;
    await render();
    expect(host.querySelector('[aria-label="Switch model"]')).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("has the Korean short action", async () => {
    persistPreference("ko");
    await render();
    expect(host.querySelector('[aria-label="Switch model"]')?.textContent).toBe("전환");
  });
});
