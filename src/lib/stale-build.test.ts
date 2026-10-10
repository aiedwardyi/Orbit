import { describe, expect, it, vi } from "vitest";

import { STALE_RELOAD_KEY, STALE_RELOAD_WINDOW_MS } from "../../shared/stale-reload";
import { holdReload, reloadHeld } from "./reload-hold";
import { reloadOnce, uiEntry, watchUiBuild, type UiBuildPage } from "./stale-build";

const BUILT = (entry: string) =>
  `<!doctype html>\r\n<html><head>\r\n<script>var font = "/fonts/x.woff2";</script>\r\n<script type="module" crossorigin src="/assets/${entry}"></script>\r\n<link rel="stylesheet" crossorigin href="/assets/index-DuTTcLL8.css">\r\n</head><body><div id="root"></div></body></html>`;
const DEV = `<html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;

function memoryStore(entries: Array<[string, string]> = []) {
  const values = new Map(entries);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

function fakePage(overrides: Partial<UiBuildPage> = {}) {
  const settles: Array<() => void> = [];
  const state = { typing: false, visible: true };
  const page: UiBuildPage = {
    ownHtml: () => BUILT("index-AAAA1111.js"),
    fetchHtml: vi.fn(async () => BUILT("index-BBBB2222.js")),
    typing: () => state.typing,
    visible: () => state.visible,
    held: reloadHeld,
    onSettle: (settle) => {
      settles.push(settle);
      return () => settles.splice(settles.indexOf(settle), 1);
    },
    reload: vi.fn(() => true),
    ...overrides,
  };
  return { page, state, settle: () => [...settles].forEach((settle) => settle()), listening: () => settles.length };
}

describe("reloadOnce", () => {
  it("reloads once, then refuses inside the window", () => {
    const store = memoryStore();
    const reload = vi.fn();
    expect(reloadOnce(store, reload, 1_000_000)).toBe(true);
    expect(store.values.get(STALE_RELOAD_KEY)).toBe("1000000");
    expect(reloadOnce(store, reload, 1_000_000 + STALE_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the window has passed", () => {
    const store = memoryStore([[STALE_RELOAD_KEY, "1000000"]]);
    const reload = vi.fn();
    expect(reloadOnce(store, reload, 1_000_000 + STALE_RELOAD_WINDOW_MS)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads without a storage guard", () => {
    const reload = vi.fn();
    expect(reloadOnce(undefined, reload, 1)).toBe(false);
    const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(reloadOnce(broken, reload, 1)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("holdReload", () => {
  it("holds until every piece of work resolves or rejects", async () => {
    const send = deferred();
    const upload = deferred();
    expect(reloadHeld()).toBe(false);
    expect(holdReload(send.promise)).toBe(send.promise);
    void holdReload(upload.promise).catch(() => {});
    expect(reloadHeld()).toBe(true);
    send.resolve();
    await send.promise;
    expect(reloadHeld()).toBe(true);
    upload.reject(new TypeError("Load failed"));
    await upload.promise.catch(() => {});
    expect(reloadHeld()).toBe(false);
  });
});

describe("uiEntry", () => {
  it("reads the hashed entry script of a built index.html", () => {
    expect(uiEntry(BUILT("index-O3Xh-52R.js"))).toBe("/assets/index-O3Xh-52R.js");
  });

  it("finds none on the dev server", () => {
    expect(uiEntry(DEV)).toBeNull();
  });
});

describe("watchUiBuild", () => {
  it("reloads when the server serves a different entry", async () => {
    const { page } = fakePage();
    expect(await watchUiBuild(page).check()).toBe("stale");
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the page on the same build", async () => {
    const { page } = fakePage({ fetchHtml: async () => BUILT("index-AAAA1111.js") });
    expect(await watchUiBuild(page).check()).toBe("same");
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("keeps the page when the check fails", async () => {
    const offline = fakePage({ fetchHtml: async () => { throw new Error("offline"); } });
    expect(await watchUiBuild(offline.page).check()).toBe("failed");
    const signIn = fakePage({ fetchHtml: async () => "<html>sign in</html>" });
    expect(await watchUiBuild(signIn.page).check()).toBe("failed");
    expect(offline.page.reload).not.toHaveBeenCalled();
    expect(signIn.page.reload).not.toHaveBeenCalled();
  });

  it("never checks from the dev server", async () => {
    const { page } = fakePage({ ownHtml: () => DEV });
    expect(await watchUiBuild(page).check()).toBe("dev");
    expect(page.fetchHtml).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("waits for a focused text field to blur", async () => {
    const { page, state, settle, listening } = fakePage();
    state.typing = true;
    const watch = watchUiBuild(page);
    expect(await watch.check()).toBe("stale");
    expect(await watch.check()).toBe("stale");
    settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(listening()).toBe(1);
    state.typing = false;
    settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(listening()).toBe(0);
  });

  it.each([
    { typing: false, visible: true },
    { typing: true, visible: true },
    { typing: false, visible: false },
    { typing: true, visible: false },
  ])("waits for held work with typing $typing and visible $visible", async ({ typing, visible }) => {
    const { page, state, settle, listening } = fakePage();
    const send = deferred();
    void holdReload(send.promise);
    Object.assign(state, { typing, visible });
    expect(await watchUiBuild(page).check()).toBe("stale");
    settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(listening()).toBe(1);
    state.typing = false;
    send.resolve();
    await send.promise;
    settle();
    settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(listening()).toBe(0);
  });

  it("reloads a hidden page even with a field focused", async () => {
    const { page, state, settle } = fakePage();
    state.typing = true;
    await watchUiBuild(page).check();
    state.visible = false;
    settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
});
