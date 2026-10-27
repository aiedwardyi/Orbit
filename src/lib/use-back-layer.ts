import { useEffect, useId, useRef } from "react";

declare global {
  interface WindowEventMap {
    "orbit:back-layer": CustomEvent<{ key: string; close?: () => void }>;
  }
}

export function useBackLayer(open: boolean, close: () => void) {
  const id = useId();
  const key = `popup:${id}`;
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open || window.ogb) return;
    window.dispatchEvent(new CustomEvent("orbit:back-layer", { detail: { key, close: () => closeRef.current() } }));
    return () => {
      window.dispatchEvent(new CustomEvent("orbit:back-layer", { detail: { key } }));
    };
  }, [key, open]);
}
