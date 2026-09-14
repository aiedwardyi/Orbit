// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderDialog(props?: Partial<Parameters<typeof ConfirmDialog>[0]>) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(ConfirmDialog, {
          title: "Delete this bot?",
          body: "This permanently deletes Ada and its conversation.",
          confirmLabel: "Delete",
          onConfirm,
          onCancel,
          ...props,
        }),
      ),
    ),
  );
  return { host, root, onConfirm, onCancel };
}

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label);
const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("ConfirmDialog", () => {
  it("renders the title, body, and both actions", async () => {
    const { host, root } = await renderDialog();
    try {
      expect(dialog()?.textContent).toContain("Delete this bot?");
      expect(dialog()?.textContent).toContain("This permanently deletes Ada");
      expect(button("Delete")).not.toBeUndefined();
      expect(button("Cancel")).not.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("confirms only through the confirm action", async () => {
    const { host, root, onConfirm, onCancel } = await renderDialog();
    try {
      await act(async () => click(button("Delete")!));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("cancels through the cancel action, Escape, and backdrop press — never through the panel", async () => {
    const { host, root, onConfirm, onCancel } = await renderDialog();
    try {
      // A press inside the panel is not a backdrop press.
      await act(async () =>
        dialog()!.querySelector("h2")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      );
      expect(onCancel).not.toHaveBeenCalled();

      await act(async () => click(button("Cancel")!));
      expect(onCancel).toHaveBeenCalledTimes(1);

      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(onCancel).toHaveBeenCalledTimes(2);

      await act(async () =>
        dialog()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      );
      expect(onCancel).toHaveBeenCalledTimes(3);
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("lands initial focus on Cancel so Enter cannot confirm by accident", async () => {
    const { host, root } = await renderDialog();
    try {
      expect(document.activeElement?.textContent).toBe("Cancel");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
