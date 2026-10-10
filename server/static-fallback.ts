import { STALE_RELOAD_KEY, STALE_RELOAD_WINDOW_MS } from "../shared/stale-reload.ts";

export type MissingStaticResponse = { status: number; headers: Record<string, string>; body: string };

// A page from an older build asks for chunk names this build no longer has.
// Hanging after reload() keeps the view's loading state up until the page goes.
export const STALE_CHUNK_MODULE = `let reload = false;
try {
  const age = Date.now() - Number(sessionStorage.getItem(${JSON.stringify(STALE_RELOAD_KEY)}));
  reload = !(age >= 0 && age < ${STALE_RELOAD_WINDOW_MS});
  if (reload) sessionStorage.setItem(${JSON.stringify(STALE_RELOAD_KEY)}, String(Date.now()));
} catch {}
if (reload) {
  location.reload();
  await new Promise(() => {});
}
throw new Error("this page's UI build is gone; reload to update");
`;

/** What a missing static file answers. Null keeps the SPA fallback (the app shell). */
export function missingStaticResponse(pathname: string): MissingStaticResponse | null {
  if (!pathname.startsWith("/assets/")) return null;
  if (pathname.endsWith(".js")) {
    return { status: 200, headers: { "content-type": "text/javascript", "cache-control": "no-store" }, body: STALE_CHUNK_MODULE };
  }
  return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
}
