import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { PreviewImage } from "@/lib/media-viewer";
import { reducedMotion } from "@/lib/phone-swipe";
import { useBackLayer } from "@/lib/use-back-layer";
import {
  atFit, fitView, imageFrame, KEY_STEP, panBy, resizeView, toggleZoomAt,
  wheelZoomFactor, zoomAround, zoomKeyAction, type ZoomFrame, type ZoomKeyAction, type ZoomView,
} from "./image-zoom";

type Point = { x: number; y: number };
type Drag = { point: Point; view: ZoomView; lastY: number; lastTime: number; velocity: number; moved: boolean; touch: boolean; axis: "x" | "y" | null };

export function MediaViewer({ image, closing = false, onClose, previous, next, onNavigate }: {
  image: PreviewImage;
  closing?: boolean;
  onClose: () => void;
  previous?: boolean;
  next?: boolean;
  onNavigate?: (direction: number) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const frame = useRef<ZoomFrame | null>(null);
  const view = useRef<ZoomView>({ scale: 1, panX: 0, panY: 0 });
  const rect = useRef({ left: 0, top: 0 });
  const natural = useRef({ w: 0, h: 0 });
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<{ distance: number; mid: Point; view: ZoomView } | null>(null);
  const dismiss = useRef(0);
  const swipeX = useRef(0);
  const raf = useRef(0);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef<{ point: Point; time: number } | null>(null);
  const closed = useRef(false);
  const callbacks = useRef({ onClose, onNavigate, previous, next, closing });
  callbacks.current = { onClose, onNavigate, previous, next, closing };
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const src = attempt ? `${image.src}${image.src.includes("?") ? "&" : "?"}retry=${attempt}` : image.src;

  const close = () => {
    if (closed.current || callbacks.current.closing) return;
    closed.current = true;
    callbacks.current.onClose();
  };
  useBackLayer(!closing, close);

  const wake = () => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.controls = "visible";
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => { root.dataset.controls = "hidden"; }, 1500);
  };

  const paint = () => {
    raf.current = 0;
    const f = frame.current;
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.transform = dismiss.current || swipeX.current ? `translate3d(${swipeX.current}px, ${dismiss.current}px, 0)` : "";
    if (!f || !img) return;
    const v = view.current;
    const x = (f.viewW - f.sourceW * v.scale) / 2 + v.panX;
    const y = (f.viewH - f.sourceH * v.scale) / 2 + v.panY;
    img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${v.scale})`;
    stage.dataset.zoom = String(v.scale);
    stage.dataset.fit = String(atFit(v, f));
  };

  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(paint);
  };

  const apply = (value: ZoomView) => {
    view.current = value;
    schedule();
    if (imgRef.current) imgRef.current.style.willChange = "transform";
    clearTimeout(inputTimer.current);
    inputTimer.current = setTimeout(() => { if (imgRef.current) imgRef.current.style.willChange = ""; }, 180);
    wake();
  };

  const center = () => ({ x: (frame.current?.viewW ?? 0) / 2, y: (frame.current?.viewH ?? 0) / 2 });
  const shortcut = (action: ZoomKeyAction) => {
    const f = frame.current;
    if (!f) return;
    apply(action === "reset" ? fitView(f) : zoomAround(view.current, center(), f, action === "in" ? KEY_STEP : 1 / KEY_STEP));
    if (action === "reset") setAnnouncement(t("viewer.fit"));
  };

  const navigate = (direction: number) => {
    if (direction < 0 ? callbacks.current.previous : callbacks.current.next) callbacks.current.onNavigate?.(direction);
  };

  const measure = () => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || natural.current.w < 1) return;
    const bounds = stage.getBoundingClientRect();
    rect.current = { left: bounds.left - swipeX.current, top: bounds.top - dismiss.current };
    if (stage.clientWidth < 1 || stage.clientHeight < 1) return;
    const f = imageFrame(stage.clientWidth, stage.clientHeight, natural.current.w, natural.current.h);
    view.current = frame.current ? resizeView(view.current, frame.current, f) : fitView(f);
    frame.current = f;
    img.style.width = `${f.sourceW}px`;
    img.style.height = `${f.sourceH}px`;
    paint();
  };

  useLayoutEffect(() => {
    frame.current = null;
    natural.current = { w: 0, h: 0 };
    pointers.current.clear();
    drag.current = null;
    pinch.current = null;
    dismiss.current = 0;
    swipeX.current = 0;
    lastTap.current = null;
    clearTimeout(tapTimer.current);
    setFailed(false);
    setAttempt(0);
    setAnnouncement("");
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) {
      natural.current = { w: img.naturalWidth, h: img.naturalHeight };
      measure();
    }
    wake();
  }, [image.src]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (closing) return;
    const root = rootRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== root);
    const inert = background.map((node) => node.inert);
    background.forEach((node) => { node.inert = true; });
    root.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], audio, video')) return;
      const action = zoomKeyAction(event);
      if (action && !(window.ogb?.imageZoom && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        shortcut(action);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
        wake();
      } else if (event.key === "Tab") {
        wake();
        const controls = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => getComputedStyle(el).display !== "none");
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
        event.stopImmediatePropagation();
      } else if (event.altKey || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    const api = window.ogb?.imageZoom;
    api?.own(true);
    const off = api?.onShortcut(shortcut);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      off?.();
      api?.own(false);
      background.forEach((node, index) => { node.inert = inert[index]; });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [closing]);

  useEffect(() => {
    const root = rootRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const f = frame.current;
      if (!f || callbacks.current.closing) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? f.viewH : 1);
      apply(zoomAround(view.current, { x: event.clientX - rect.current.left, y: event.clientY - rect.current.top }, f, wheelZoomFactor(delta)));
    };
    const prevent = (event: Event) => event.preventDefault();
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchmove", prevent, { passive: false });
    root.addEventListener("gesturestart", prevent);
    root.addEventListener("gesturechange", prevent);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchmove", prevent);
      root.removeEventListener("gesturestart", prevent);
      root.removeEventListener("gesturechange", prevent);
      cancelAnimationFrame(raf.current);
      clearTimeout(controlsTimer.current);
      clearTimeout(inputTimer.current);
      clearTimeout(tapTimer.current);
    };
  }, []);

  const point = (event: ReactPointerEvent) => ({ x: event.clientX - rect.current.left, y: event.clientY - rect.current.top });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (callbacks.current.closing || (event.target instanceof Element && event.target.closest("button")) || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const p = point(event);
    pointers.current.set(event.pointerId, p);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no capture. */ }
    if (pointers.current.size >= 2) {
      clearTimeout(tapTimer.current);
      lastTap.current = null;
      drag.current = null;
      dismiss.current = 0;
      swipeX.current = 0;
      schedule();
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: view.current };
    } else {
      drag.current = { point: p, view: view.current, lastY: p.y, lastTime: event.timeStamp, velocity: 0, moved: false, touch: event.pointerType === "touch", axis: null };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const f = frame.current;
    if (!pointers.current.has(event.pointerId)) return;
    const p = point(event);
    pointers.current.set(event.pointerId, p);
    const start = pinch.current;
    if (pointers.current.size >= 2 && start && f) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      apply(zoomAround(start.view, start.mid, f, Math.hypot(b.x - a.x, b.y - a.y) / start.distance, { x: mid.x - start.mid.x, y: mid.y - start.mid.y }));
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (event.timeStamp > d.lastTime) d.velocity = (p.y - d.lastY) / (event.timeStamp - d.lastTime);
    d.lastY = p.y;
    d.lastTime = event.timeStamp;
    const dx = p.x - d.point.x;
    const dy = p.y - d.point.y;
    if (!d.moved && Math.hypot(dx, dy) >= 8) {
      d.moved = true;
      d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      clearTimeout(tapTimer.current);
      lastTap.current = null;
    }
    if (!d.moved) return;
    if (f && !atFit(d.view, f)) apply(panBy(d.view, dx, dy, f));
    else if (d.touch && d.axis === "y") {
      dismiss.current = reducedMotion() ? 0 : Math.max(0, dy);
      schedule();
    } else if (d.touch && d.axis === "x") {
      swipeX.current = reducedMotion() ? 0 : dx;
      schedule();
    }
  };

  const settle = () => {
    const stage = stageRef.current;
    if (stage && (dismiss.current || swipeX.current) && !reducedMotion()) {
      stage.animate?.([{ transform: `translate3d(${swipeX.current}px, ${dismiss.current}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: 160, easing: "ease-out" });
    }
    dismiss.current = 0;
    swipeX.current = 0;
    schedule();
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const f = frame.current;
    const d = drag.current;
    const p = point(event);
    const wasPinch = pinch.current !== null;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    if (wasPinch && !cancelled && pointers.current.size === 1) {
      const remaining = [...pointers.current.values()][0];
      drag.current = { point: remaining, view: view.current, lastY: remaining.y, lastTime: event.timeStamp, velocity: 0, moved: true, touch: false, axis: null };
    }
    if (!d || wasPinch || cancelled) { settle(); return; }
    const dx = p.x - d.point.x;
    const dy = p.y - d.point.y;
    if (d.moved) {
      if (d.touch && (!f || atFit(d.view, f))) {
        if (d.axis === "y" && (dy >= 96 || (dy >= 24 && event.timeStamp - d.lastTime < 100 && d.velocity > 0.6))) { close(); return; }
        if (d.axis === "x" && Math.abs(dx) >= 64) navigate(dx < 0 ? 1 : -1);
      }
      settle();
      return;
    }
    const last = lastTap.current;
    clearTimeout(tapTimer.current);
    if (f && last && event.timeStamp - last.time < 300 && Math.hypot(p.x - last.point.x, p.y - last.point.y) < 28) {
      lastTap.current = null;
      apply(toggleZoomAt(view.current, p, f));
      setAnnouncement(atFit(view.current, f) ? t("viewer.fit") : t("viewer.native"));
    } else {
      lastTap.current = { point: p, time: event.timeStamp };
      tapTimer.current = setTimeout(() => {
        lastTap.current = null;
        const root = rootRef.current;
        if (!root) return;
        if (root.dataset.controls === "hidden") wake();
        else { clearTimeout(controlsTimer.current); root.dataset.controls = "hidden"; }
      }, 300);
    }
  };

  return createPortal(
    <div ref={rootRef} role={closing ? undefined : "dialog"} aria-modal={!closing || undefined}
      aria-label={t("viewer.preview", { name: image.name })} tabIndex={-1} inert={closing}
      data-media-viewer="" data-controls="visible" data-closing={closing || undefined}
      className="orbit-inset-aware fixed inset-0 z-[70] flex touch-none flex-col overflow-hidden bg-panel text-ink outline-none"
      onPointerMove={wake}>
      <header data-viewer-controls="" className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 bg-panel/95 px-4 backdrop-blur-sm">
        <div className="min-w-0 truncate text-[13px] font-medium" aria-live="polite">{image.name}</div>
        <div className="flex shrink-0 items-center gap-1">
          <a href={image.src} download={image.name} target="_blank" rel="noreferrer" className="media-viewer-button" aria-label={t("viewer.download", { name: image.name })} title={t("viewer.downloadTitle")}><Download size={18} /></a>
          <button onClick={close} data-viewer-close="" className="media-viewer-button" aria-label={t("viewer.close")} title={t("viewer.close")}><X size={20} /></button>
        </div>
      </header>
      <div ref={stageRef} data-image-stage="" data-fit="true"
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-inset"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={(event) => endPointer(event)} onPointerCancel={(event) => endPointer(event, true)}>
        {failed ? <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
          <ImageOff size={34} /><p>{t("viewer.unavailable")}</p>
          {image.caption && <p className="max-w-prose px-4 text-center text-[13px]">{image.caption}</p>}
          <button className="rounded-lg bg-raised px-4 py-3 text-ink" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>{t("viewer.retry")}</button>
        </div> : <img ref={imgRef} key={image.src} src={src} alt={image.name} draggable={false}
          className="absolute left-0 top-0 h-full w-full max-w-none object-contain" style={{ transformOrigin: "0 0", maxWidth: "none" }}
          onLoad={(event) => { natural.current = { w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight }; measure(); }}
          onError={() => setFailed(true)} />}
      </div>
      {previous && <button data-viewer-controls="" data-viewer-previous="" className="media-viewer-button absolute left-4 top-1/2 rounded-full border border-hairline/40 bg-panel/95 max-md:hidden" onClick={() => navigate(-1)} aria-label={t("viewer.previous")} title={t("viewer.previous")}><ChevronLeft size={22} /></button>}
      {next && <button data-viewer-controls="" data-viewer-next="" className="media-viewer-button absolute right-4 top-1/2 rounded-full border border-hairline/40 bg-panel/95 max-md:hidden" onClick={() => navigate(1)} aria-label={t("viewer.next")} title={t("viewer.next")}><ChevronRight size={22} /></button>}
      {!failed && <div data-viewer-controls="" className="media-viewer-zoom absolute left-1/2 flex -translate-x-1/2 rounded-full border border-hairline/40 bg-panel/95 px-1 shadow-sm">
        <button className="media-viewer-button px-3 text-[13px]" title={t("viewer.fitShortcut")} aria-label={t("viewer.fitShortcut")} onClick={() => shortcut("reset")}>{t("viewer.fit")}</button>
        <button className="media-viewer-button px-3 text-[13px]" title={t("viewer.nativeShortcut")} aria-label={t("viewer.nativeShortcut")} onClick={() => { if (frame.current) apply(zoomAround(view.current, center(), frame.current, (frame.current.fit === 1 ? 2 : 1) / view.current.scale)); setAnnouncement(t("viewer.native")); }}>{t("viewer.native")}</button>
      </div>}
      <span role="status" className="sr-only">{announcement}</span>
    </div>, document.body,
  );
}
