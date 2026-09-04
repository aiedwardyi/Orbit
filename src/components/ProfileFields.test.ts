import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  dispatch: vi.fn(),
  config: {
    profile: { name: "", email: "" },
  } as { profile: { name: string; email: string } },
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { config: mock.config },
      dispatch: mock.dispatch,
    }),
  };
});

import { ProfileFields } from "./ProfileFields";

function fillInput(input: HTMLInputElement, value: string) {
  input.focus();
  const proto = Object.getPrototypeOf(input) as HTMLInputElement;
  const setter =
    Object.getOwnPropertyDescriptor(proto, "value")?.set ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTMLInputElement value setter is missing");
  setter.call(input, value);
  const tracker = (input as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  tracker?.setValue("");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ProfileFields Save", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    mock.dispatch.mockReset();
  });

  it("does not PUT on blur and sends a normalized profile on Save", async () => {
    const saved = { profile: { name: "Ada Lovelace", email: "ada@example.com" } };
    const request = vi.fn<(input: string, init?: RequestInit) => Promise<{ json: () => Promise<typeof saved> }>>(
      async () => ({ json: async () => saved }),
    );
    vi.stubGlobal("fetch", request);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ProfileFields));
    });

    const name = host.querySelector<HTMLInputElement>('input[placeholder="Your name"]');
    const email = host.querySelector<HTMLInputElement>('input[placeholder="you@example.com"]');
    const save = host.querySelector<HTMLButtonElement>('button[aria-label="Save name and email"]');
    expect(name).toBeTruthy();
    expect(email).toBeTruthy();
    expect(save).toBeTruthy();

    await act(async () => {
      fillInput(name!, "  Ada Lovelace  ");
      fillInput(email!, " Ada@Example.com ");
    });
    expect(name!.value).toBe("  Ada Lovelace  ");
    expect(email!.value.toLowerCase()).toBe("ada@example.com");

    await act(async () => {
      name!.blur();
      email!.blur();
    });
    expect(request).not.toHaveBeenCalled();

    await act(async () => {
      save!.click();
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/config");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: { name: "Ada Lovelace", email: "ada@example.com" },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });

    await act(async () => {
      root.unmount();
    });
  });
});
