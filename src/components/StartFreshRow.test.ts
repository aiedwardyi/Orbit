// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StartFreshRow } from "./StartFreshRow";

afterEach(() => {
  delete window.ogb;
  localStorage.setItem("omb-locale", "en");
});

function typeReset(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it("cancel does nothing and repeated confirm calls reset only once", async () => {
  const startFresh = vi.fn(() => new Promise<void>(() => {}));
  Object.defineProperty(window, "ogb", { value: { startFresh }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = (button: Element) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StartFreshRow))));
    await act(async () => click(host.querySelector("button")!));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("A backup copy is kept on this PC.");
    const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
    await act(async () => click(buttons().find((button) => button.textContent === "Cancel")!));
    expect(startFresh).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => click(host.querySelector("button")!));
    const field = document.querySelector('[role="dialog"] input');
    if (!(field instanceof HTMLInputElement)) throw new Error("missing confirm field");
    await act(async () => typeReset(field, "RESET"));
    const confirm = buttons().find((button) => button.textContent === "Start fresh")!;
    await act(async () => { click(confirm); click(confirm); });
    expect(startFresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("cancel clears a half-typed confirmation word", async () => {
  Object.defineProperty(window, "ogb", { value: { startFresh: vi.fn() }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = (button: Element) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StartFreshRow))));
    await act(async () => click(host.querySelector("button")!));
    const field = document.querySelector('[role="dialog"] input');
    if (!(field instanceof HTMLInputElement)) throw new Error("missing confirm field");
    await act(async () => typeReset(field, "RESE"));
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Cancel")!;
    await act(async () => click(cancel));
    expect(field.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("stays disabled until the typed word matches, then Enter confirms and Escape cancels", async () => {
  const startFresh = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "ogb", { value: { startFresh }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = (button: Element) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const confirmButton = () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Start fresh");
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StartFreshRow))));
    await act(async () => click(host.querySelector("button")!));
    const field = document.querySelector('[role="dialog"] input');
    if (!(field instanceof HTMLInputElement)) throw new Error("missing confirm field");
    expect(field.getAttribute("placeholder")).toBe("RESET");
    const confirm = confirmButton();
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("missing confirm button");
    expect(confirm.disabled).toBe(true);
    await act(async () => typeReset(field, "nope"));
    expect(confirmButton()?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(startFresh).not.toHaveBeenCalled();
    await act(async () => typeReset(field, "  reset  "));
    expect(confirmButton()?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(startFresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => click(host.querySelector("button")!));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(startFresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("accepts 초기화 in Korean and rejects RESET", async () => {
  localStorage.setItem("omb-locale", "ko");
  const startFresh = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "ogb", { value: { startFresh }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = (button: Element) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StartFreshRow))));
    await act(async () => click(host.querySelector("button")!));
    const field = document.querySelector('[role="dialog"] input');
    if (!(field instanceof HTMLInputElement)) throw new Error("missing confirm field");
    expect(field.getAttribute("placeholder")).toBe("초기화");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("백업 사본은 이 PC에 남겨 둬요.");
    await act(async () => typeReset(field, "RESET"));
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "처음부터 다시 시작");
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    await act(async () => typeReset(field, " 초기화 "));
    expect(confirm?.hasAttribute("disabled")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
