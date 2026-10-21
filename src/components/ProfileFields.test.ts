import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  dispatch: vi.fn(),
  config: {
    profile: { name: "", email: "" },
  } as { profile: { name: string; email: string; avatarUrl?: string } },
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
  const name = host.querySelector<HTMLInputElement>("#settings-profile-name");
  const email = host.querySelector<HTMLInputElement>("#settings-profile-email");
  const save = host.querySelector<HTMLButtonElement>('button[aria-label="Save Name"]');
  expect(name).toBeTruthy();
  expect(email).toBeNull();
  expect(save).toBeTruthy();
  expect(host.querySelector('label[for="settings-profile-name"]')?.textContent).toBe("Name");
  expect(host.querySelector('label[for="settings-profile-email"]')).toBeNull();
  return { host, root, name: name!, save: save! };
}

describe("ProfileFields Save", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    mock.dispatch.mockReset();
  });

  it("does not PUT on blur and sends a normalized profile on Save", async () => {
    const saved = { profile: { name: "Ada Lovelace" } };
    let finish: ((value: FetchResult) => void) | undefined;
    const request = vi.fn<(input: string, init?: RequestInit) => Promise<FetchResult>>(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", request);

    const { root, name, save } = await renderProfile();
    await act(async () => {
      fillInput(name, "  Ada Lovelace  ");
    });
    expect(name.value).toBe("  Ada Lovelace  ");

    await act(async () => {
      name.blur();
    });
    expect(request).not.toHaveBeenCalled();

    await act(async () => {
      save.click();
    });
    expect(name.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/config");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: { name: "Ada Lovelace" },
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

  it("skips a blank Save when no name is stored", async () => {
    const request = vi.fn<(input: string, init?: RequestInit) => Promise<FetchResult>>();
    vi.stubGlobal("fetch", request);
    const { root, save } = await renderProfile();
    await act(async () => {
      save.click();
    });
    expect(request).not.toHaveBeenCalled();
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

    const { host, root, name, save } = await renderProfile();
    await act(async () => {
      fillInput(name, "Ada");
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

describe("ProfileFields photo", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    mock.dispatch.mockReset();
    mock.config = { profile: { name: "", email: "" } };
  });

  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ?? null;

  function pick(host: HTMLElement, file: File) {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("offers Change Photo and shows Remove Photo only when a photo is set", async () => {
    const empty = await renderProfile();
    expect(button(empty.host, "Change Photo")).toBeTruthy();
    expect(button(empty.host, "Remove Photo")).toBeNull();
    expect(empty.host.querySelector('input[type="file"]')?.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(empty.host.textContent).toContain("PNG, JPEG, GIF, or WebP");
    await act(async () => empty.root.unmount());

    mock.config = { profile: { name: "Ada", email: "", avatarUrl: "/api/attachments/ada.png" } };
    const set = await renderProfile();
    expect(button(set.host, "Remove Photo")).toBeTruthy();
    expect(set.host.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/ada.png");
    await act(async () => set.root.unmount());
  });

  it("uploads the picked image and saves it as the profile photo", async () => {
    const saved = { profile: { name: "", email: "", avatarUrl: "/api/attachments/new.png" } };
    const request = vi.fn(async (input: string, _init?: RequestInit): Promise<FetchResult> =>
      input === "/api/attachments"
        ? { ok: true, json: async () => ({ path: "C:/data/attachments/new.png", mime: "image/png", bytes: 4 }) }
        : { ok: true, json: async () => saved });
    vi.stubGlobal("fetch", request);

    const { root, host } = await renderProfile();
    await act(async () => pick(host, new File([new Uint8Array([1, 2, 3, 4])], "me.png", { type: "image/png" })));
    await flush();

    expect(request.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual(["POST /api/attachments", "PUT /api/config"]);
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toEqual({ profile: { avatarUrl: "/api/attachments/new.png" } });
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
    await act(async () => root.unmount());
  });

  it("refuses a file that is not a supported image", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    const { root, host } = await renderProfile();
    await act(async () => pick(host, new File(["<svg/>"], "me.svg", { type: "image/svg+xml" })));
    await flush();

    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Choose a PNG, JPEG, GIF, or WebP image");
    await act(async () => root.unmount());
  });

  it("removes the photo", async () => {
    mock.config = { profile: { name: "Ada", email: "", avatarUrl: "/api/attachments/ada.png" } };
    const saved = { profile: { name: "Ada", email: "", avatarUrl: "" } };
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<FetchResult> => ({ ok: true, json: async () => saved }));
    vi.stubGlobal("fetch", request);

    const { root, host } = await renderProfile();
    await act(async () => button(host, "Remove Photo")!.click());
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]?.method).toBe("PUT");
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ profile: { avatarUrl: "" } });
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
    await act(async () => root.unmount());
  });
});
