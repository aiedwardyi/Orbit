import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adjacentMedia, markdownImage, mediaList, type MediaMessage, type MediaReference, type PreviewImage } from "@/lib/media-viewer";
import { useI18n } from "@/lib/i18n";
import { MediaViewer } from "./MediaViewer";

const MediaContext = createContext<{
  open: (image: PreviewImage, opener: HTMLElement) => void;
  register: (image: MediaReference) => () => void;
} | null>(null);

export function MediaViewerProvider({ threadId, messages, children }: { threadId: string; messages: readonly MediaMessage[]; children: ReactNode }) {
  const [selected, setSelected] = useState<PreviewImage | null>(null);
  const [rendered, setRendered] = useState<MediaReference[]>([]);
  const [seenThread, setSeenThread] = useState(threadId);
  if (seenThread !== threadId) {
    setSeenThread(threadId);
    setSelected(null);
    setRendered([]);
  }
  const images = useMemo(() => mediaList(messages, rendered), [messages, rendered]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const open = useCallback((image: PreviewImage, opener: HTMLElement) => {
    opener.focus({ preventScroll: true });
    const messageId = opener.closest("[data-mid]")?.getAttribute("data-mid");
    setSelected(imagesRef.current.find((item) => item.messageId === messageId && item.src === image.src)
      ?? imagesRef.current.find((item) => item.src === image.src) ?? image);
  }, []);
  const register = useCallback((image: MediaReference) => {
    setRendered((items) => [...items, image]);
    return () => setRendered((items) => items.filter((item) => item !== image));
  }, []);
  const context = useMemo(() => ({ open, register }), [open, register]);
  return <MediaContext.Provider value={context}>
    {children}
    {selected && <MediaViewer image={selected} onClose={() => setSelected(null)}
      previous={Boolean(adjacentMedia(images, selected, -1))} next={Boolean(adjacentMedia(images, selected, 1))}
      onNavigate={(direction) => setSelected((current) => current && (adjacentMedia(imagesRef.current, current, direction) ?? current))} />}
  </MediaContext.Provider>;
}

export function useMediaViewer() {
  return useContext(MediaContext);
}

export function ReadableImage({ src, alt = "", ...props }: { src?: string; alt?: string; className?: string; loading?: "lazy"; "data-phone-media"?: string }) {
  const { t } = useI18n();
  const viewer = useMediaViewer();
  const ref = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState(false);
  const image = useMemo(() => markdownImage(src, alt), [src, alt]);
  useEffect(() => {
    const messageId = ref.current?.closest("[data-mid]")?.getAttribute("data-mid");
    if (!viewer || !image || !messageId) return;
    return viewer.register({ ...image, messageId, id: `${messageId}:${image.src}` });
  }, [viewer, image]);
  if (!image) return <img src={src} alt={alt} {...props} />;
  return <>
    <button ref={ref} type="button" className="inline-block max-w-full rounded-lg text-left focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={t("viewer.open", { name: image.name })}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (viewer) viewer.open(image, event.currentTarget); else { event.currentTarget.focus({ preventScroll: true }); setSelected(true); } }}>
      <img src={src} alt={alt} {...props} />
    </button>
    {selected && <MediaViewer image={image} onClose={() => setSelected(false)} />}
  </>;
}
