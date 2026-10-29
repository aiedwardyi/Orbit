// Chips for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste collapses into a card of its
// first lines instead of flooding the composer; a file dropped anywhere
// on the window attaches by path.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, File as FileIcon, Image as ImageIcon, MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { holdReload } from "@/lib/reload-hold";
import {
  attachmentImageUrl,
  intakeFiles,
  formatSize,
  pasteImageAttachment,
  pasteSummary,
  type Attachment,
  type PasteAttachment,
  type UploadAttachment,
} from "@/lib/composer-attachments";
import { usePresence } from "@/lib/use-presence";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";

/** Electron 32 removed File.path — only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

/** Renders pending attachments and their composer actions. */
export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
  onDisplayInChatBox,
  allowImages = true,
  notice,
  onNotice,
  onCancelUpload = onRemove,
  onRetryUpload,
  onRepickUpload,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[], uploads: { id: string; file: File }[], startedAt?: number) => void;
  onRemove: (id: string) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onCancelUpload?: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onRepickUpload?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const previewPresence = usePresence(preview);
  // dragenter/dragleave fire once per element crossed, so the overlay
  // tracks depth rather than the last event it happened to see
  const depth = useRef(0);

  useEffect(() => {
    let active = true;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // without preventDefault the window navigates to the dropped file and
    // the app is simply gone
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const startedAt = performance.now();
      // Same intake the attach button uses: a dropped file and a picked one
      // must not appear in a different order.
      const { attachments, uploads, notice: message } = await intakeFiles(files, {
        t,
        allowImages,
        getPath: pathForFile,
        uploadImage: pasteImageAttachment,
      });
      if (!active) return;
      if (attachments.length) onAdd(attachments, uploads, startedAt);
      // onAdd clears only a notice from before this drop started, so an error
      // a concurrent intake just raised stays until the user reads it.
      if (message) onNotice(message);
    };
    const onDrop = (e: DragEvent) => void holdReload(drop(e));

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      active = false;
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAdd, allowImages, onNotice, t]);

  return (
    <>
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-10">
          <div className="rounded-2xl border-2 border-dashed border-accent/70 bg-panel/90 px-8 py-6 text-[14px] font-medium text-ink shadow-2xl">
            Drop to attach — the bot gets the file path
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => onNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pr-1.5 pt-1.5">
          {items.map((a) =>
            a.kind === "paste" ? (
              <Chip
                key={a.id}
                kind="PASTED"
                title={a.text.slice(0, 4000)}
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
                </div>
                <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(a)}</div>
                <button
                  type="button"
                  onClick={() => onDisplayInChatBox(a)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1.5 text-[10.5px] font-medium text-accent-text transition-colors hover:border-accent/50 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  aria-label="Display pasted text in chat box"
                  title="Display in chat box"
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span>Display in chat box</span>
                </button>
              </Chip>
            ) : a.kind === "image" ? (
              <Chip key={a.id} kind="IMAGE" title={a.name} onRemove={() => onRemove(a.id)}>
                <button
                  type="button"
                  onClick={() => setPreview(previewImage(a.path))}
                  className="flex h-[76px] w-full items-center justify-center overflow-hidden rounded-lg bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  aria-label={`Preview ${a.name}`}
                >
                  <img
                    src={attachmentImageUrl(a.path) ?? undefined}
                    alt={a.name}
                    loading="lazy"
                    className="max-h-[76px] max-w-full object-contain"
                  />
                </button>
                <div className="mt-1 truncate text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
              </Chip>
            ) : a.kind === "upload" ? (
              <Chip
                key={a.id}
                kind="FILE"
                title={a.name}
                onRemove={() => onCancelUpload(a.id)}
                removeLabel={t("composer.uploadCancel")}
              >
                <UploadBody upload={a} onRetry={() => onRetryUpload?.(a.id)} onRepick={() => onRepickUpload?.(a.id)} />
              </Chip>
            ) : (
              <Chip key={a.id} kind="FILE" title={a.path} onRemove={() => onRemove(a.id)}>
                <div className="flex h-[76px] items-center gap-2">
                  <FileIcon size={16} className="shrink-0 text-ink-secondary" />
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{a.name}</div>
                    <div className="text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
                  </div>
                </div>
              </Chip>
            ),
          )}
        </div>
      )}
      {previewPresence.value && (
        <AttachmentPreviewDialog image={previewPresence.value} closing={previewPresence.closing} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

function UploadBody({ upload, onRetry, onRepick }: { upload: UploadAttachment; onRetry: () => void; onRepick: () => void }) {
  const { t } = useI18n();
  const percent = upload.size ? Math.min(100, Math.floor((upload.sent / upload.size) * 100)) : 0;
  const action = "mt-0.5 block break-keep text-left text-[10.5px] leading-snug text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60";
  return (
    <>
      <div className="flex h-[76px] items-center gap-2">
        <FileIcon size={16} className="shrink-0 text-ink-secondary" />
        <div className="min-w-0">
          {/* an action line lifts the name under the always-on touch x */}
          <div className={cn("truncate text-[12px] text-ink", (upload.state === "failed" || upload.state === "repick") && "pointer-coarse:pr-5")}>
            {upload.name}
          </div>
          <div className="truncate text-[10.5px] text-ink-secondary/70">
            {formatSize(upload.size)}
            {upload.state === "uploading" && ` · ${percent}%`}
            {upload.state === "resuming" && ` · ${t("composer.uploadResuming")}`}
          </div>
          {upload.state === "failed" && (
            <button type="button" onClick={onRetry} className={action}>
              {t("composer.uploadRetry")}
            </button>
          )}
          {upload.state === "repick" && (
            <button type="button" onClick={onRepick} className={action}>
              {t("composer.uploadRepick")}
            </button>
          )}
        </div>
      </div>
      {upload.state !== "repick" && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          <div className="absolute bottom-0 left-0 h-[2px] bg-accent" style={{ width: `${percent}%` }} />
        </div>
      )}
    </>
  );
}

function Chip({
  children,
  kind,
  title,
  onRemove,
  removeLabel,
}: {
  children: React.ReactNode;
  kind: "PASTED" | "FILE" | "IMAGE";
  title: string;
  onRemove: () => void;
  removeLabel?: string;
}) {
  const { t } = useI18n();
  const Icon = kind === "PASTED" ? ClipboardPaste : kind === "IMAGE" ? ImageIcon : FileIcon;
  const label = t(kind === "PASTED" ? "composer.chipPasted" : kind === "IMAGE" ? "composer.chipImage" : "composer.chipFile");
  return (
    <div
      title={title}
      className={cn(
        "group relative w-[172px] shrink-0 rounded-xl border border-hairline/40 bg-raised px-2.5 py-2",
        "transition-colors hover:border-hairline",
      )}
    >
      {children}
      <div className="mt-1 flex items-center gap-1">
        <Icon size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          {label}
        </span>
      </div>
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard. Touch has no hover, so
          it always shows there. */}
      <button
        onClick={onRemove}
        aria-label={removeLabel ?? t(kind === "PASTED" ? "composer.removePasted" : kind === "IMAGE" ? "composer.removeImage" : "composer.removeFile")}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:right-1 pointer-coarse:top-1 pointer-coarse:size-6 pointer-coarse:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
