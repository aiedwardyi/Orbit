// Shared confirm step for destructive actions: backdrop and Escape cancel,
// initial focus lands on Cancel so an accidental Enter never confirms, Tab
// cycles inside the panel, and focus returns to its previous owner on close.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The call-site passes a fresh inline callback every render; the keyboard
  // effect below must not re-subscribe (or refocus) for that, so it always
  // calls through to the latest one instead of depending on it.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  // Mount-only: remember who had focus, start on Cancel, give focus back on
  // close when that owner is still in the document.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  // Mount-only: the dialog owns the keyboard while open. Escape cancels from
  // the capture phase and stops there, so one press never also closes the
  // sidebar (or anything else) underneath; Tab cycles inside the panel, and
  // focus that somehow left is pulled back in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        className="animate-pop-in w-full max-w-[400px] rounded-[24px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50"
      >
        <h2 id={titleId} className="text-[17px] font-semibold text-ink">
          {title}
        </h2>
        {body && (
          <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            {body}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-full bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover"
          >
            {cancelLabel ?? t("createBot.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              danger
                ? "rounded-full border border-danger/30 px-4 py-2 text-[13px] font-medium text-danger hover:bg-danger/10"
                : "rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
