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

type FetchResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderProfile() {
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
  return { host, root, name: name!, email: email!, save: save! };
}

describe("ProfileFields Save", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    mock.dispatch.mockReset();
  });

  it("does not PUT on blur and sends a normalized profile on Save", async () => {
    const saved = { profile: { name: "Ada Lovelace", email: "ada@example.com" } };
    let finish: ((value: FetchResult) => void) | undefined;
    const request = vi.fn<(input: string, init?: RequestInit) => Promise<FetchResult>>(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", request);

    const { root, name, email, save } = await renderProfile();
    await act(async () => {
      fillInput(name, "  Ada Lovelace  ");
      fillInput(email, " Ada@Example.com ");
    });
    expect(name.value).toBe("  Ada Lovelace  ");
    // type="email" strips surrounding spaces in the DOM; casing stays unnormalized until Save.
    expect(email.value).toBe("Ada@Example.com");

    await act(async () => {
      name.blur();
      email.blur();
    });
    expect(request).not.toHaveBeenCalled();

    await act(async () => {
      save.click();
    });
    expect(name.disabled).toBe(true);
    expect(email.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/config");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: { name: "Ada Lovelace", email: "ada@example.com" },
    });

    await act(async () => {
      finish?.({ ok: true, json: async () => saved });
    });
    await flush();
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
    expect(name.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not dispatch configStatus when Save fails", async () => {
    const request = vi.fn<(input: string, init?: RequestInit) => Promise<FetchResult>>(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ error: "save failed" }),
    }));
    vi.stubGlobal("fetch", request);

    const { host, root, name, email, save } = await renderProfile();
    await act(async () => {
      fillInput(name, "Ada");
      fillInput(email, "ada@example.com");
      save.click();
    });
    await flush();

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("save failed");

    await act(async () => {
      root.unmount();
    });
  });
});
