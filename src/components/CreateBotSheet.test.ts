// CreateBotSheet folder choice: a rejected native pick is a silent no-op,
// and the dialog scrolls so the action row stays reachable in short views.
import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

interface MockSheetState {
  instances?: InstanceInfo[];
}

const { mockState } = vi.hoisted(() => {
  const value: MockSheetState = {};
  return { mockState: { value } };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState.value,
      dispatch: () => undefined,
    }),
  };
});

import { CreateBotSheet } from "./CreateBotSheet";

function setOgbPick(pickFolder: (current?: string) => Promise<string | null>) {
  Object.defineProperty(window, "ogb", {
    configurable: true,
    writable: true,
    value: { pickFolder },
  });
}

async function renderSheet(options: {
  required?: boolean;
  initialSection?: string;
  onCreated?: (bot: Bot) => void;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(CreateBotSheet, { required: options.required ?? true, ...options }));
  });
  const dialog = host.querySelector('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error("sheet did not render");
  return { host, root, dialog };
}

function addFolderLink(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Folder"),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("add-folder link did not render");
  return found;
}

async function revealFolder(host: HTMLElement): Promise<HTMLInputElement> {
  await act(async () => {
    addFolderLink(host).click();
  });
  const folder = host.querySelector<HTMLInputElement>("#create-bot-folder");
  if (!folder) throw new Error("folder field did not render");
  return folder;
}

function chooseButton(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Choose"),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("folder choose control did not render");
  return found;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

afterEach(() => {
  Object.defineProperty(window, "ogb", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  mockState.value = {};
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function availableEngine(instanceId = "fast"): InstanceInfo {
  // SAFETY: the resolver reads only snapshot.state, models.default and rateLimits.windows.
  return {
    instanceId,
    driverKind: "testAgent",
    displayName: instanceId,
    snapshot: { state: "available" },
    models: { default: `${instanceId}-model`, options: [] },
  } as InstanceInfo;
}

function stubPostBot() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ bot: { id: "b1" } }), { status: 201 });
    }),
  );
  return calls;
}

async function fillJob(host: HTMLElement, text: string) {
  const field = host.querySelector<HTMLInputElement>("#create-bot-job");
  if (!field) throw new Error("job field did not render");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
    setValue.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}

async function pressEnter(field: HTMLInputElement) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
}

describe("CreateBotSheet submit", () => {
  it("submits on Enter without a stored selection when no engine is usable", async () => {
    const calls = stubPostBot();
    const { host, root } = await renderSheet();
    try {
      const field = await fillJob(host, "weekly brief");
      await pressEnter(field);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("/api/bots");
      expect(calls[0]?.body).toMatchObject({ job: "weekly brief" });
      expect(calls[0]?.body).not.toHaveProperty("modelSelection");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("leaves job out of the body when submitted blank", async () => {
    const calls = stubPostBot();
    const { host, root } = await renderSheet();
    try {
      const field = host.querySelector<HTMLInputElement>("#create-bot-job");
      if (!field) throw new Error("job field did not render");
      await pressEnter(field);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).not.toHaveProperty("job");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("sends the resolved default selection so creation skips discovery", async () => {
    mockState.value = { instances: [availableEngine()] };
    const calls = stubPostBot();
    const { host, root } = await renderSheet();
    try {
      const field = await fillJob(host, "weekly brief");
      await pressEnter(field);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toMatchObject({
        job: "weekly brief",
        modelSelection: { mode: "automatic", instanceId: "fast", model: "fast-model" },
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("files a nested creation in its group and reports the new bot", async () => {
    const calls = stubPostBot();
    const onCreated = vi.fn();
    const { host, root } = await renderSheet({ initialSection: " Work ", onCreated });
    try {
      const field = await fillJob(host, "weekly brief");
      await pressEnter(field);
      expect(calls[0]?.body).toMatchObject({ section: "Work" });
      expect(onCreated).toHaveBeenCalledWith({ id: "b1" });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("shows Adding bot while the create request is in flight", async () => {
    let resolvePost!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvePost = resolve;
          }),
      ),
    );
    const { host, root } = await renderSheet();
    try {
      const field = await fillJob(host, "weekly brief");
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(host.textContent).toContain("Adding bot");
      await act(async () => {
        resolvePost(new Response(JSON.stringify({ bot: { id: "b1" } }), { status: 201 }));
      });
      await flush();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("CreateBotSheet folder choice", () => {
  it("keeps the dialog within the viewport with scrolling so actions stay reachable", async () => {
    const { host, root, dialog } = await renderSheet();
    try {
      expect(dialog.className).toContain("100dvh");
      expect(dialog.className).toContain("overflow-y-auto");
      const submit = [...host.querySelectorAll("button")].find(
        (button) => button.type === "submit",
      );
      expect(submit instanceof HTMLButtonElement).toBe(true);
      if (submit) expect(dialog.contains(submit)).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps one left edge and an even action row on a phone", async () => {
    const { host, root, dialog } = await renderSheet({ required: false });
    try {
      expect(dialog.className).toContain("p-5");
      expect(dialog.className).toContain("sm:p-7");
      const header = dialog.firstElementChild!;
      expect(header.className).toContain("max-sm:flex-col");
      // "+ Folder" carries its own plus, so the folder glyph would be a second icon.
      expect(addFolderLink(host).querySelector("svg")).toBeNull();
      const actions = [...host.querySelectorAll("button")].filter(
        (button) => button.type === "submit" || button.textContent === "Cancel",
      );
      expect(actions).toHaveLength(2);
      for (const action of actions) expect(action.className).toContain("max-sm:flex-1");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("hides the folder row behind a link until it's clicked", async () => {
    const { host, root } = await renderSheet();
    try {
      expect(host.querySelector("#create-bot-folder")).toBeNull();
      const folder = await revealFolder(host);
      expect(folder).toBeInstanceOf(HTMLInputElement);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("fills the field when the native pick resolves", async () => {
    setOgbPick(() => Promise.resolve("/tmp/picked"));
    const { host, root } = await renderSheet();
    try {
      const folder = await revealFolder(host);
      await act(async () => {
        chooseButton(host).click();
      });
      await flush();
      expect(folder.value).toBe("/tmp/picked");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("treats a rejected native pick as a silent no-op", async () => {
    setOgbPick(() => Promise.reject(new Error("cancelled")));
    const { host, root } = await renderSheet();
    const rejections: Array<unknown> = [];
    const onUnhandled = (reason: {} | null | undefined) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const folder = await revealFolder(host);
      await act(async () => {
        chooseButton(host).click();
      });
      await flush();
      expect(folder.value).toBe("");
      expect(host.querySelector("[role=alert]")).toBeNull();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await act(async () => {
        root.unmount();
      });
    }
  });
});
