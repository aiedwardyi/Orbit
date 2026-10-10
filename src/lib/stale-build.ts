// A phone page opened before a home update keeps running the old UI build.
// Its lazy views ask for chunk names the server no longer has, and it misses
// new features until it reloads. Both paths reload once onto the new build.
import { lazy, useEffect, useRef, type ComponentType } from "react";
import { STALE_RELOAD_KEY, staleReloadAllowed } from "../../shared/stale-reload";
import { onHoldReleased, reloadHeld } from "./reload-hold";

type GuardStore = Pick<Storage, "getItem" | "setItem"> | undefined;

function sessionStore(): GuardStore {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/** True when this call reloaded. Without a working guard it never reloads, so a broken build can't loop. */
export function reloadOnce(store = sessionStore(), reload = () => location.reload(), now = Date.now()): boolean {
  try {
    if (!store || !staleReloadAllowed(Number(store.getItem(STALE_RELOAD_KEY)), now)) return false;
    store.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** React.lazy whose failed chunk reloads the page once; a second failure reaches the view's boundary. */
export function lazyView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: Error): Promise<{ default: T }> => {
      if (reloadOnce()) return new Promise(() => {});
      throw error;
    }),
  );
}

const ENTRY = /<script\b[^>]*\bsrc="(\/assets\/index-[\w-]+\.js)"/;

/** The hashed entry script an index.html loads; null on the dev server. */
export function uiEntry(html: string): string | null {
  return ENTRY.exec(html)?.[1] ?? null;
}

export interface UiBuildPage {
  ownHtml: () => string;
  fetchHtml: () => Promise<string>;
  typing: () => boolean;
  visible: () => boolean;
  held: () => boolean;
  /** Calls `settle` on every blur, visibility change or last held work settling until the returned stop runs. */
  onSettle: (settle: () => void) => () => void;
  reload: () => boolean;
}

export type UiBuildCheck = "dev" | "failed" | "same" | "stale";

/** Reloads onto a newer build the server serves, never while a text field has focus or held work is in flight. */
export function watchUiBuild(page: UiBuildPage) {
  let waiting: (() => void) | null = null;
  const stopWaiting = () => {
    waiting?.();
    waiting = null;
  };
  const reloadWhenIdle = () => {
    if (waiting) return;
    const settle = () => {
      if (page.held() || (page.typing() && page.visible())) return;
      stopWaiting();
      page.reload();
    };
    waiting = page.onSettle(settle);
    settle();
  };
  const check = async (): Promise<UiBuildCheck> => {
    const own = uiEntry(page.ownHtml());
    if (!own) return "dev";
    let fresh: string | null;
    try {
      fresh = uiEntry(await page.fetchHtml());
    } catch {
      return "failed";
    }
    if (!fresh) return "failed";
    if (fresh === own) return "same";
    reloadWhenIdle();
    return "stale";
  };
  return { check, stop: stopWaiting };
}

const TEXT_FIELD =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="tel"], input[type="number"]';

function browserPage(): UiBuildPage {
  return {
    ownHtml: () => document.head.innerHTML,
    fetchHtml: async () => {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET / ${res.status}`);
      return res.text();
    },
    typing: () => {
      const active = document.activeElement;
      return active instanceof HTMLElement && (active.matches(TEXT_FIELD) || active.isContentEditable);
    },
    visible: () => document.visibilityState === "visible",
    held: reloadHeld,
    onSettle: (settle) => {
      // focus has not landed on the next field yet while focusout runs
      const afterBlur = () => setTimeout(settle, 0);
      document.addEventListener("focusout", afterBlur);
      document.addEventListener("visibilitychange", settle);
      const stopHeld = onHoldReleased(settle);
      return () => {
        document.removeEventListener("focusout", afterBlur);
        document.removeEventListener("visibilitychange", settle);
        stopHeld();
      };
    },
    reload: () => reloadOnce(),
  };
}

/** Browser pages only: checks for a newer build on return to the foreground and on every reconnect. */
export function useStaleBuildReload(connected: boolean) {
  const watch = useRef<ReturnType<typeof watchUiBuild> | null>(null);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (window.ogb) return;
    const current = watchUiBuild(browserPage());
    watch.current = current;
    const onVisible = () => {
      if (document.visibilityState === "visible") void current.check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      current.stop();
      watch.current = null;
    };
  }, []);
  useEffect(() => {
    if (!connected) return;
    if (wasConnected.current) void watch.current?.check();
    wasConnected.current = true;
  }, [connected]);
}
