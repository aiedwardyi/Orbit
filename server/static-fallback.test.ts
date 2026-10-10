import { describe, expect, it, vi } from "vitest";

import { STALE_RELOAD_KEY, STALE_RELOAD_WINDOW_MS } from "../shared/stale-reload.ts";
import { missingStaticResponse, STALE_CHUNK_MODULE } from "./static-fallback.ts";

// SAFETY: an async arrow's prototype constructor is AsyncFunction.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

function runModule(storage: Map<string, string>) {
  const reload = vi.fn();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  const run = new AsyncFunction("sessionStorage", "location", STALE_CHUNK_MODULE);
  let settled: "pending" | "resolved" | "rejected" = "pending";
  void run(sessionStorage, { reload }).then(() => (settled = "resolved"), () => (settled = "rejected"));
  return { reload, settled: async () => (await new Promise((done) => setTimeout(done, 10)), settled) };
}

describe("missingStaticResponse", () => {
  it("answers a missing chunk with a no-store reload module", () => {
    const res = missingStaticResponse("/assets/RemoteTerminalView-OLDHASH0.js");
    expect(res?.status).toBe(200);
    expect(res?.headers).toEqual({ "content-type": "text/javascript", "cache-control": "no-store" });
    expect(res?.body).toBe(STALE_CHUNK_MODULE);
  });

  it("answers any other missing asset with 404", () => {
    expect(missingStaticResponse("/assets/SettingsModal-OLDHASH0.css")?.status).toBe(404);
    expect(missingStaticResponse("/assets/font.woff2")?.status).toBe(404);
  });

  it("keeps the app shell for every non-asset path", () => {
    expect(missingStaticResponse("/")).toBeNull();
    expect(missingStaticResponse("/remote")).toBeNull();
    expect(missingStaticResponse("/settings.js")).toBeNull();
  });
});

describe("STALE_CHUNK_MODULE", () => {
  it("reloads once and holds the import open", async () => {
    const storage = new Map<string, string>();
    const first = runModule(storage);
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(await first.settled()).toBe("pending");
    expect(Number(storage.get(STALE_RELOAD_KEY))).toBeGreaterThan(0);
  });

  it("fails the import instead of reloading again inside the window", async () => {
    const storage = new Map([[STALE_RELOAD_KEY, String(Date.now() - 1_000)]]);
    const again = runModule(storage);
    expect(again.reload).not.toHaveBeenCalled();
    expect(await again.settled()).toBe("rejected");
  });

  it("reloads again once the window has passed", async () => {
    const storage = new Map([[STALE_RELOAD_KEY, String(Date.now() - STALE_RELOAD_WINDOW_MS - 1)]]);
    expect(runModule(storage).reload).toHaveBeenCalledTimes(1);
  });
});
