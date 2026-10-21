import "./ProfileFields.test-dom.ts";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, translate, type Translate } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { EngineMark, engineHoverText } from "./EngineMark";

let root: Root | undefined;
let host: HTMLDivElement;

function instance(snapshot: Partial<InstanceInfo["snapshot"]> = {}, partial: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: "claudeAgent", driverKind: "claudeAgent", displayName: "Claude",
    snapshot: { state: "available", authenticated: true, account: "me@example.com", ...snapshot },
    models: { default: "", options: [] },
    ...partial,
  };
}

async function render(element: ReactElement) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, element)));
}

const trigger = () => host.querySelector<HTMLElement>("[data-engine-hover]")!;
const card = () => document.querySelector<HTMLElement>("[data-engine-card]:not([data-closing])");
const pointer = (type: string, pointerType: string, target: Element = trigger(), init: PointerEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new window.PointerEvent(type, { pointerType, bubbles: true, cancelable: true, ...init }) as unknown as Event);
  });
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  applyLocale("en");
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  document.querySelectorAll("[data-engine-card]").forEach((node) => node.remove());
  vi.useRealTimers();
});

describe("engineHoverText", () => {
  const t: Translate = (key, vars) => translate("en", key, vars);
  const ko: Translate = (key, vars) => translate("ko", key, vars);

  it("names the engine and its account", () => {
    expect(engineHoverText(instance(), t)).toBe("Claude · me@example.com");
    expect(engineHoverText(instance(), ko)).toBe("Claude · me@example.com");
  });

  it("says signed in when no account is recorded", () => {
    expect(engineHoverText(instance({ account: undefined }), t)).toBe("Claude · Signed in");
    expect(engineHoverText(instance({ account: undefined }), ko)).toBe("Claude · 로그인됨");
  });

  it("says not signed in for anything short of signed in", () => {
    expect(engineHoverText(instance({ authenticated: false, account: undefined }), t)).toBe("Claude · Not signed in");
    expect(engineHoverText(instance({ authenticated: false, account: undefined }), ko)).toBe("Claude · 로그인되지 않음");
    expect(engineHoverText(instance({ authenticated: undefined }), t)).toBe("Claude · Not signed in");
    expect(engineHoverText(instance({ state: "unavailable" }), t)).toBe("Claude · Not signed in");
  });
});

describe("EngineMark", () => {
  it("opens after a hover delay and closes on leave", async () => {
    await render(createElement(EngineMark, { instance: instance() }));
    await pointer("pointerover", "mouse");
    await wait(100);
    expect(card()).toBeNull();
    await wait(400);
    expect(card()?.textContent).toBe("Claude · me@example.com");
    expect(card()?.getAttribute("role")).toBe("tooltip");
    await pointer("pointerout", "mouse", trigger(), { relatedTarget: host });
    expect(card()).toBeNull();
  });

  it("closes on Escape and on a page scroll", async () => {
    await render(createElement(EngineMark, { instance: instance() }));
    await pointer("pointerover", "mouse");
    await wait(500);
    await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
    expect(card()).toBeNull();
    await pointer("pointerover", "mouse", host);
    await pointer("pointerover", "mouse");
    await wait(500);
    expect(card()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new window.Event("scroll") as unknown as Event); });
    expect(card()).toBeNull();
  });

  it("opens on keyboard focus and names the account for screen readers", async () => {
    await render(createElement(EngineMark, { instance: instance({ authenticated: false, account: undefined }) }));
    expect(trigger().getAttribute("tabindex")).toBe("0");
    expect(trigger().getAttribute("aria-label")).toBe("Claude · Not signed in");
    const matches = vi.spyOn(trigger(), "matches").mockImplementation((selector: string) => selector === ":focus-visible");
    await act(async () => trigger().focus());
    expect(card()?.textContent).toBe("Claude · Not signed in");
    await act(async () => trigger().blur());
    expect(card()).toBeNull();
    matches.mockRestore();
  });

  it("opens on a touch hold outside a button, but leaves a button's tap alone", async () => {
    await render(createElement("div", null,
      createElement(EngineMark, { instance: instance() }),
      createElement("button", { type: "button" }, createElement(EngineMark, { instance: instance({ account: "other@example.com" }) })),
    ));
    const [plain, nested] = host.querySelectorAll<HTMLElement>("[data-engine-hover]");
    expect(nested.hasAttribute("tabindex")).toBe(false);
    await pointer("pointerdown", "touch", nested);
    await wait(600);
    expect(card()).toBeNull();
    await pointer("pointerdown", "touch", plain, { clientX: 5, clientY: 5 });
    await pointer("pointermove", "touch", plain, { clientX: 40, clientY: 5 });
    await wait(600);
    expect(card()).toBeNull();
    await pointer("pointerdown", "touch", plain);
    await wait(600);
    expect(card()?.textContent).toBe("Claude · me@example.com");
    await pointer("pointerdown", "touch", host);
    expect(card()).toBeNull();
  });
});
