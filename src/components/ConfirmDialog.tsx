// Shared confirm step for destructive actions: backdrop and Escape cancel,
// and initial focus lands on Cancel so an accidental Enter never confirms.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

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
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
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
