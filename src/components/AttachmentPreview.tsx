// Saved paths resolve through the attachment route before loading.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageOff, Maximize2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePresence } from "@/lib/use-presence";
import { previewImage, type PreviewImage } from "@/lib/media-viewer";
import { MediaViewer } from "./MediaViewer";
import { useMediaViewer } from "./MediaViewerProvider";

export { previewImage, type PreviewImage };
export const AttachmentPreviewDialog = MediaViewer;

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

function Thumbnail({ image, onPreview }: { image: PreviewImage; onPreview: (opener: HTMLElement) => void }) {
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
      onClick={(event) => onPreview(event.currentTarget)}
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
  const viewer = useMediaViewer();
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
          <Thumbnail key={`${image.src}:${index}`} image={image} onPreview={(opener) => { if (viewer) viewer.open(image, opener); else { opener.focus({ preventScroll: true }); setSelected(image); } }} />
        ))}
      </div>
      {preview.value && <AttachmentPreviewDialog image={preview.value} closing={preview.closing} onClose={() => setSelected(null)} />}
    </>
  );
}

/** A show_image message. A synced row whose file never reached this machine keeps its caption. */
export function ShownImage({ name, caption }: { name: string; caption?: string }) {
  const viewer = useMediaViewer();
  const image = useMemo(() => {
    const image = previewImage(name);
    return image ? { ...image, caption } : null;
  }, [name, caption]);
  const retry = usePictureRetry(image?.src ?? "");
  const [open, setOpen] = useState(false);
  const preview = usePresence(open && image);
  return (
    <div className="flex flex-col items-start gap-1">
      {image && !retry.failed ? (
        <button
          type="button"
          onClick={(event) => { if (viewer) viewer.open(image, event.currentTarget); else { event.currentTarget.focus({ preventScroll: true }); setOpen(true); } }}
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
