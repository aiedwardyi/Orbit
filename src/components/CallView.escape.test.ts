// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, Group } from "@/state/store";

const mock = vi.hoisted(() => ({ settingsOpen: false, dispatched: [] as unknown[] }));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        appSettingsOpen: mock.settingsOpen,
        appSettingsSection: "general",
        bots: [],
        config: {
          composio: { configured: false },
          gemini: { configured: false },
          box: { configured: false },
          vps: { configured: false, sshAlias: "" },
          rooms: { turnTimeoutMinutes: 5 },
          localVm: { mode: "shared", maxInstances: 1 },
          profile: { name: "", email: "" },
          features: { skillRecorder: false, showToolCalls: false },
        },
      },
      dispatch: (action: Action) => { mock.dispatched.push(action); },
    }),
  };
});

vi.mock("./EnginesSettings", () => ({ EnginesSettings: () => null }));
vi.mock("./UsageSection", () => ({ UsageSection: () => null }));

import { I18nProvider } from "@/lib/i18n";
import { currentCall, endCall, startCall } from "@/lib/call";
import { CallOverlay } from "./CallView";
import { GroupCallOverlay } from "./GroupCallView";
import { SettingsModal } from "./SettingsModal";

const bot = { id: "bot-1", name: "Ada", messages: [] } as unknown as Bot;
const group = { id: "room-1", name: "Room", messages: [] } as unknown as Group;

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = null;
  endCall();
  mock.settingsOpen = false;
  mock.dispatched.length = 0;
  document.body.innerHTML = "";
});

async function mount(overlay: "bot" | "group", settingsOpen: boolean) {
  mock.settingsOpen = settingsOpen;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const target = overlay === "bot" ? bot : group;
  await act(async () => startCall(target.id));
  await act(async () =>
    root!.render(
      createElement(
        I18nProvider,
        null,
        overlay === "bot" ? createElement(CallOverlay, { bot }) : createElement(GroupCallOverlay, { group, members: [] }),
        settingsOpen ? createElement(SettingsModal) : null,
      ),
    ),
  );
  return target.id;
}

const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

describe.each([["bot"], ["group"]] as const)("%s call Escape", (overlay) => {
  it("closes Settings and keeps the call live", async () => {
    const id = await mount(overlay, true);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    await escape();
    expect(mock.dispatched).toContainEqual({ type: "toggleAppSettings", open: false });
    expect(currentCall()).toBe(id);
  });

  it("still hangs up when no modal is open", async () => {
    await mount(overlay, false);
    await escape();
    expect(currentCall()).toBeNull();
  });
});
