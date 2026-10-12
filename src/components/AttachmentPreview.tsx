// Same-origin image thumbnails and an in-app lightbox. Transcript text can
// contain arbitrary strings, so callers pass saved paths and this component
// resolves them through attachmentImageUrl rather than loading them as URLs.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Download, ImageOff, Maximize2, X } from "lucide-react";

import { attachmentBasename, attachmentImageUrl } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { usePresence } from "@/lib/use-presence";
import {
  FIT_VIEW,
  KEY_STEP,
  clampPan,
  panBy,
  toggleZoomAt,
  wheelPanOffset,
  wheelZoomFactor,
  zoomAround,
  zoomKeyAction,
  type ZoomFrame,
  type ZoomKeyAction,
} from "./image-zoom";

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

function stageFrame(stage: HTMLElement, naturalW: number, naturalH: number): { frame: ZoomFrame; padL: number; padT: number } | null {
  const style = getComputedStyle(stage);
  const padL = Number.parseFloat(style.paddingLeft) || 0;
  const padR = Number.parseFloat(style.paddingRight) || 0;
  const padT = Number.parseFloat(style.paddingTop) || 0;
  const padB = Number.parseFloat(style.paddingBottom) || 0;
  const viewW = stage.clientWidth - padL - padR;
  const viewH = stage.clientHeight - padT - padB;
  if (viewW < 2 || viewH < 2 || naturalW < 1 || naturalH < 1) return null;
  const fit = Math.min(viewW / naturalW, viewH / naturalH);
  return { frame: { viewW, viewH, fitW: naturalW * fit, fitH: naturalH * fit }, padL, padT };
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
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef(onClose);
  const retry = usePictureRetry(image.src);
  const [seenSrc, setSeenSrc] = useState(image.src);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [metrics, setMetrics] = useState<{ frame: ZoomFrame; padL: number; padT: number } | null>(null);
  const [view, setView] = useState(FIT_VIEW);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<ZoomFrame | null>(null);
  const padRef = useRef({ left: 0, top: 0 });
  const viewRef = useRef(view);
  const draggingRef = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number; moved: boolean; pointerType: string } | null>(null);
  const pinch = useRef<{ startDist: number; startView: typeof FIT_VIEW; startMid: { x: number; y: number } } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const backdropDown = useRef<{ x: number; y: number } | null>(null);
  const applyShortcutRef = useRef<(action: ZoomKeyAction) => void>(() => {});

  if (seenSrc !== image.src) {
    setSeenSrc(image.src);
    setView(FIT_VIEW);
    setNatural({ w: 0, h: 0 });
    setMetrics(null);
    setDragging(false);
  }
  frameRef.current = metrics?.frame ?? null;
  padRef.current = { left: metrics?.padL ?? 0, top: metrics?.padT ?? 0 };
  viewRef.current = view;
  applyShortcutRef.current = (action) => {
    if (action === "reset") {
      setView(FIT_VIEW);
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    const factor = action === "in" ? KEY_STEP : 1 / KEY_STEP;
    setView((current) => zoomAround(current, { x: frame.viewW / 2, y: frame.viewH / 2 }, frame, factor));
  };

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img?.complete || img.naturalWidth < 1) return;
    setNatural((current) => (
      current.w === img.naturalWidth && current.h === img.naturalHeight ? current : { w: img.naturalWidth, h: img.naturalHeight }
    ));
  }, [retry.src]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || natural.w < 1) {
      setMetrics(null);
      return;
    }
    const measure = () => {
      const next = stageFrame(stage, natural.w, natural.h);
      setMetrics((current) => {
        if (!next) return null;
        if (
          current
          && current.padL === next.padL
          && current.padT === next.padT
          && current.frame.viewW === next.frame.viewW
          && current.frame.viewH === next.frame.viewH
          && current.frame.fitW === next.frame.fitW
          && current.frame.fitH === next.frame.fitH
        ) return current;
        return next;
      });
      if (!next) return;
      setView((current) => {
        if (current.scale <= 1) return current.scale === 1 && current.panX === 0 && current.panY === 0 ? current : FIT_VIEW;
        const clamped = clampPan(
          current.panX,
          current.panY,
          next.frame.fitW * current.scale,
          next.frame.fitH * current.scale,
          next.frame.viewW,
          next.frame.viewH,
        );
        if (clamped.x === current.panX && clamped.y === current.panY) return current;
        return { ...current, panX: clamped.x, panY: clamped.y };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [natural.w, natural.h]);

  useEffect(() => {
    const api = window.ogb?.imageZoom;
    if (!api) return;
    api.own(true);
    const off = api.onShortcut((action) => applyShortcutRef.current(action));
    return () => {
      off();
      api.own(false);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: Event) => {
      if (!(event instanceof WheelEvent)) return;
      event.preventDefault();
      const frame = frameRef.current;
      if (!frame) return;
      if (!event.ctrlKey) {
        if (viewRef.current.scale <= 1) return;
        const { dx, dy } = wheelPanOffset(event, frame);
        if (dx === 0 && dy === 0) return;
        setView((current) => panBy(current, dx, dy, frame));
        return;
      }
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left - padRef.current.left,
        y: event.clientY - rect.top - padRef.current.top,
      };
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta = event.deltaY * 16;
      else if (event.deltaMode === 2) delta = event.deltaY * frame.viewH;
      const factor = wheelZoomFactor(delta);
      setView((current) => zoomAround(current, point, frame, factor));
    };
    const stop = (event: Event) => event.preventDefault();
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchmove", stop, { passive: false });
    root.addEventListener("gesturestart", stop);
    root.addEventListener("gesturechange", stop);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchmove", stop);
      root.removeEventListener("gesturestart", stop);
      root.removeEventListener("gesturechange", stop);
    };
  }, []);

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
      if (!window.ogb?.imageZoom) {
        const action = zoomKeyAction(event);
        if (action) {
          event.preventDefault();
          applyShortcutRef.current(action);
          return;
        }
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

  const contentPoint = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      x: clientX - rect.left - padRef.current.left,
      y: clientY - rect.top - padRef.current.top,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = contentPoint(event.clientX, event.clientY);
    if (!point || !frameRef.current) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser did not start cannot be captured.
    }
    if (pointers.current.size >= 2) {
      drag.current = null;
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      if (!a || !b) return;
      pinch.current = {
        startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        startView: viewRef.current,
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }
    pinch.current = null;
    drag.current = {
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      moved: false,
      pointerType: event.pointerType,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = contentPoint(event.clientX, event.clientY);
    const frame = frameRef.current;
    if (!point || !frame) return;
    pointers.current.set(event.pointerId, point);
    const pinchStart = pinch.current;
    if (pointers.current.size >= 2 && pinchStart) {
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      if (!a || !b) return;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAround(pinchStart.startView, pinchStart.startMid, frame, dist / pinchStart.startDist);
      setView(panBy(zoomed, mid.x - pinchStart.startMid.x, mid.y - pinchStart.startMid.y, frame));
      return;
    }
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) >= 6) gesture.moved = true;
    if (!gesture.moved || viewRef.current.scale <= 1) return;
    if (!draggingRef.current) {
      draggingRef.current = true;
      setDragging(true);
    }
    setView(panBy({ scale: viewRef.current.scale, panX: gesture.panX, panY: gesture.panY }, dx, dy, frame));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, toggle: boolean) => {
    const point = contentPoint(event.clientX, event.clientY);
    const frame = frameRef.current;
    const gesture = drag.current?.pointerId === event.pointerId ? drag.current : null;
    const wasPinch = pinch.current !== null;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (gesture) drag.current = null;
    if (draggingRef.current && pointers.current.size === 0) {
      draggingRef.current = false;
      setDragging(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!toggle || wasPinch || !gesture || gesture.moved || !point || !frame) return;
    if (gesture.pointerType === "touch") {
      const last = lastTap.current;
      if (last && event.timeStamp - last.t < 300 && Math.hypot(point.x - last.x, point.y - last.y) < 28) {
        lastTap.current = null;
        setView((current) => toggleZoomAt(current, point, frame));
        return;
      }
      lastTap.current = { t: event.timeStamp, x: point.x, y: point.y };
      return;
    }
    setView((current) => toggleZoomAt(current, point, frame));
  };

  let cursor = "cursor-zoom-in";
  if (retry.failed) cursor = "";
  else if (dragging) cursor = "cursor-grab";
  else if (view.scale > 1) cursor = "cursor-zoom-out";
  const css = metrics && natural.w > 0 ? (metrics.frame.fitW / natural.w) * view.scale : 1;
  const drawnW = natural.w * css;
  const drawnH = natural.h * css;
  const imageX = metrics ? metrics.padL + (metrics.frame.viewW - drawnW) / 2 + view.panX : 0;
  const imageY = metrics ? metrics.padT + (metrics.frame.viewH - drawnH) / 2 + view.panY : 0;

  return createPortal(
    <div
      ref={rootRef}
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-[70] flex touch-none items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        backdropDown.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = backdropDown.current;
        backdropDown.current = null;
        if (!start || event.target !== event.currentTarget) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        onClose();
      }}
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
        <div
          ref={stageRef}
          data-image-stage=""
          data-zoom={view.scale}
          className={cn(
            "relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden p-4 sm:p-8",
            cursor,
          )}
          onPointerDown={retry.failed ? undefined : onPointerDown}
          onPointerMove={retry.failed ? undefined : onPointerMove}
          onPointerUp={retry.failed ? undefined : (event) => endPointer(event, true)}
          onPointerCancel={retry.failed ? undefined : (event) => endPointer(event, false)}
        >
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
              ref={imgRef}
              src={retry.src}
              alt={image.name}
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={retry.onError}
              className={metrics
                ? "pointer-events-none absolute left-0 top-0 max-w-none rounded-lg shadow-2xl"
                : "pointer-events-none block max-h-full max-w-full rounded-lg object-contain shadow-2xl"}
              style={metrics ? {
                width: natural.w,
                height: natural.h,
                maxWidth: "none",
                maxHeight: "none",
                transformOrigin: "0 0",
                transform: `translate(${imageX}px, ${imageY}px) scale(${css})`,
              } : undefined}
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
