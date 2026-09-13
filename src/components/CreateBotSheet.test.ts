// CreateBotSheet folder choice: a rejected native pick is a silent no-op,
// and the dialog scrolls so the action row stays reachable in short views.
import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {},
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

async function renderSheet() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(CreateBotSheet, { required: true }));
  });
  const dialog = host.querySelector('[role="dialog"]');
  const folder = host.querySelector<HTMLInputElement>("#create-bot-folder");
  if (!(dialog instanceof HTMLElement) || !folder) throw new Error("sheet did not render");
  return { host, root, dialog, folder };
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
  document.body.replaceChildren();
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

  it("fills the field when the native pick resolves", async () => {
    setOgbPick(() => Promise.resolve("/tmp/picked"));
    const { host, root, folder } = await renderSheet();
    try {
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
    const { host, root, folder } = await renderSheet();
    const rejections: Array<unknown> = [];
    const onUnhandled = (reason: {} | null | undefined) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
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
