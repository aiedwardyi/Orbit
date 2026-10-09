// Same-origin image thumbnails and an in-app lightbox. Transcript text can
// contain arbitrary strings, so callers pass saved paths and this component
// resolves them through attachmentImageUrl rather than loading them as URLs.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ImageOff, Maximize2, X } from "lucide-react";

import { attachmentBasename, attachmentImageUrl } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { usePresence } from "@/lib/use-presence";

export interface PreviewImage {
  src: string;
  name: string;
}

export function previewImage(path: string): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return { src, name: attachmentBasename(path) };
}

const PICTURE_RETRY_MS = [5_000, 15_000, 45_000];

function pictureSrc(src: string, attempt: number): string {
  if (attempt <= 0) return src;
  return `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
}

function usePictureRetry(src: string) {
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [seen, setSeen] = useState(src);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (seen !== src) {
    setSeen(src);
    setAttempt(0);
    setWaiting(false);
  }
  useLayoutEffect(() => () => clearTimeout(timer.current), [src]);
  const onError = () => {
    clearTimeout(timer.current);
    const delay = PICTURE_RETRY_MS[attempt];
    setWaiting(true);
    if (delay === undefined) return;
    timer.current = setTimeout(() => {
      setWaiting(false);
      setAttempt((current) => current + 1);
    }, delay);
  };
  const retryNow = () => {
    clearTimeout(timer.current);
    setWaiting(false);
    setAttempt((current) => current + 1);
  };
  return { src: pictureSrc(src, attempt), failed: waiting, onError, retryNow };
}

export function AttachmentPreviewDialog({
  image,
  closing = false,
  onClose,
}: {
  image: PreviewImage;
  closing?: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const retry = usePictureRetry(image.src);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (closing) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [closing]);

  return createPortal(
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-label={`Preview ${image.name}`}
        tabIndex={-1}
        className="animate-pop-in flex h-full max-h-[900px] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/70 shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-black/45 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-white">{image.name}</div>
            <div className="text-[10.5px] text-white/50">Saved locally by Wink</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={image.src}
              download={image.name}
              className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
              aria-label={`Download ${image.name}`}
              title="Download"
            >
              <Download size={17} />
            </a>
            <button
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
              aria-label="Close image preview"
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-8">
          {retry.failed ? (
            <button
              type="button"
              onClick={retry.retryNow}
              className="flex flex-col items-center gap-3 text-white/60"
            >
              <ImageOff size={34} />
              <span className="text-[13px]">This attachment is no longer available.</span>
            </button>
          ) : (
            <img
              src={retry.src}
              alt={image.name}
              onError={retry.onError}
              className="block max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Thumbnail({ image, onPreview }: { image: PreviewImage; onPreview: () => void }) {
  const retry = usePictureRetry(image.src);
  if (retry.failed) {
    return (
      <button
        type="button"
        onClick={retry.retryNow}
        className="flex size-[72px] items-center justify-center rounded-lg border border-hairline/40 bg-inset text-ink-secondary"
        aria-label="Image not available"
      >
        <ImageOff size={16} />
      </button>
    );
  }
  return (
    <button
      onClick={onPreview}
      className="group/image relative block max-w-[260px] overflow-hidden rounded-lg border border-hairline/40 bg-inset text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      aria-label={`Preview attached image ${image.name}`}
      title={`Preview ${image.name}`}
    >
      <img
        src={retry.src}
        alt={image.name}
        loading="lazy"
        onError={retry.onError}
        className="block max-h-[220px] w-full object-cover transition-transform duration-200 group-hover/image:scale-[1.015]"
      />
      <span className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
        <Maximize2 size={13} />
      </span>
    </button>
  );
}

export function AttachedImageGallery({ paths, className }: { paths: string[]; className?: string }) {
  const images = useMemo(() => paths.flatMap((path) => {
    const image = previewImage(path);
    return image ? [image] : [];
  }), [paths]);
  const [selected, setSelected] = useState<PreviewImage | null>(null);
  const preview = usePresence(selected);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 flex flex-wrap justify-end gap-2", className)}>
        {images.map((image, index) => (
          <Thumbnail key={`${image.src}:${index}`} image={image} onPreview={() => setSelected(image)} />
        ))}
      </div>
      {preview.value && <AttachmentPreviewDialog image={preview.value} closing={preview.closing} onClose={() => setSelected(null)} />}
    </>
  );
}

/** A show_image message. A synced row whose file never reached this machine keeps its caption. */
export function ShownImage({ name, caption }: { name: string; caption?: string }) {
  const image = useMemo(() => previewImage(name), [name]);
  const retry = usePictureRetry(image?.src ?? "");
  const [open, setOpen] = useState(false);
  const preview = usePresence(open && image);
  return (
    <div className="flex flex-col items-start gap-1">
      {image && !retry.failed ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open image ${image.name}`}
          title={`Open ${image.name}`}
          className="block w-fit max-w-[min(42rem,78%)] cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <img
            src={retry.src}
            alt={caption || image.name}
            loading="lazy"
            onError={retry.onError}
            className="block w-full rounded-2xl border border-hairline/40"
          />
        </button>
      ) : image ? (
        <button
          type="button"
          onClick={retry.retryNow}
          className="flex items-center gap-2 rounded-2xl border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink-secondary"
        >
          <ImageOff size={14} />
          Image not available
        </button>
      ) : (
        <div
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink-secondary"
        >
          <ImageOff size={14} />
          Image not available
        </div>
      )}
      {caption && <p className="max-w-[min(42rem,78%)] px-1 text-[13px] text-ink-secondary">{caption}</p>}
      {preview.value && <AttachmentPreviewDialog image={preview.value} closing={preview.closing} onClose={() => setOpen(false)} />}
    </div>
  );
}
