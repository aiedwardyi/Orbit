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

  it("traps Tab inside the panel and pulls outside focus back in", async () => {
    const { host, root } = await renderDialog();
    // SAFETY: every call site focuses a known element first, so activeElement is set.
    const tab = (shiftKey: boolean) =>
      (document.activeElement as Element).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey }),
      );
    try {
      const cancel = button("Cancel")!;
      const confirm = button("Delete")!;
      // Wrap both directions.
      cancel.focus();
      await act(async () => tab(true));
      expect(document.activeElement).toBe(confirm);
      await act(async () => tab(false));
      expect(document.activeElement).toBe(cancel);
      // No wrap mid-dialog: Cancel -> Confirm stays put for the trap (the
      // browser moves focus natively; the trap only intervenes at the edges).
      cancel.focus();
      await act(async () => tab(false));
      expect(document.activeElement).toBe(cancel);
      // Focus that left the panel is pulled back in.
      host.tabIndex = -1;
      host.focus();
      await act(async () => tab(false));
      expect(document.activeElement).toBe(cancel);
      host.focus();
      await act(async () => tab(true));
      expect(document.activeElement).toBe(confirm);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("restores focus to its previous owner on close, if still mounted", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    // Outside the React root: unmounting the dialog must not take the owner
    // with it, or there is nothing connected left to restore to.
    const owner = document.createElement("button");
    owner.textContent = "owner";
    document.body.append(owner);
    const root = createRoot(host);
    owner.focus();
    await act(async () =>
      root.render(
        createElement(
          I18nProvider,
          null,
          createElement(ConfirmDialog, {
            title: "t",
            confirmLabel: "Delete",
            onConfirm: () => {},
            onCancel: () => {},
          }),
        ),
      ),
    );
    try {
      expect(document.activeElement?.textContent).toBe("Cancel");
      await act(async () => root.unmount());
      expect(document.activeElement).toBe(owner);
    } finally {
      owner.remove();
      host.remove();
    }
  });

  it("closes cleanly when its previous focus owner is already gone", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const owner = document.createElement("button");
    host.append(owner);
    const root = createRoot(host);
    owner.focus();
    await act(async () =>
      root.render(
        createElement(
          I18nProvider,
          null,
          createElement(ConfirmDialog, {
            title: "t",
            confirmLabel: "Delete",
            onConfirm: () => {},
            onCancel: () => {},
          }),
        ),
      ),
    );
    owner.remove();
    await act(async () => root.unmount());
    host.remove();
    expect(document.activeElement).not.toBe(owner);
    expect(dialog()).toBeNull();
  });

  it("never steals focus back on re-render and always calls the latest onCancel", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (onCancel: () => void, title: string) =>
      act(async () =>
        root.render(
          createElement(
            I18nProvider,
            null,
            createElement(ConfirmDialog, { title, confirmLabel: "Delete", onConfirm: () => {}, onCancel }),
          ),
        ),
      );
    try {
      await render(first, "one");
      button("Delete")!.focus();
      // A parent re-render with a fresh inline callback must not refocus.
      await render(second, "two");
      expect(document.activeElement?.textContent).toBe("Delete");
      // ...but Escape must reach the latest callback, not the stale one.
      // SAFETY: Delete was focused above and nothing blurred it since.
      await act(async () =>
        (document.activeElement as Element).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("stops one Escape press at the dialog so underlying closers never see it", async () => {
    const { host, root, onCancel } = await renderDialog();
    const documentSpy = vi.fn();
    const windowSpy = vi.fn();
    document.addEventListener("keydown", documentSpy);
    window.addEventListener("keydown", windowSpy);
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => button("Cancel")!.dispatchEvent(event));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(documentSpy).not.toHaveBeenCalled();
      expect(windowSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", documentSpy);
      window.removeEventListener("keydown", windowSpy);
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
