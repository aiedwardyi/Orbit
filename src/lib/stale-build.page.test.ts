// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStaleBuildReload } from "./stale-build";

// a module script would make happy-dom try to load it
const entry = (name: string) => `<script type="text/plain" src="/assets/${name}"></script>`;

let reload: ReturnType<typeof vi.fn<() => void>>;
let fetch: ReturnType<typeof vi.fn>;
let unmount: (() => Promise<void>) | null = null;

beforeEach(() => {
  document.head.innerHTML = entry("index-AAAA1111.js");
  fetch = vi.fn(async () => new Response(entry("index-BBBB2222.js")));
  vi.stubGlobal("fetch", fetch);
  reload = vi.fn<() => void>();
  vi.spyOn(location, "reload").mockImplementation(reload);
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.innerHTML = "";
});

function Page({ viewOpen }: { viewOpen: boolean }) {
  useStaleBuildReload(true, viewOpen);
  return null;
}

async function mount(viewOpen: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (open: boolean) => act(async () => root.render(createElement(Page, { viewOpen: open })));
  await render(viewOpen);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return render;
}

async function foreground() {
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => new Promise((done) => setTimeout(done, 10)));
}

describe("useStaleBuildReload", () => {
  it("waits while a view is open and reloads once it closes", async () => {
    const render = await mount(true);
    await foreground();
    expect(reload).not.toHaveBeenCalled();
    await render(false);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await render(true);
    await render(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => HTMLElement]>([
    ...["date", "time", "datetime-local", "month", "week"].map((type): [string, () => HTMLElement] => [
      `${type} input`,
      () => Object.assign(document.createElement("input"), { type }),
    ]),
    ["select", () => document.createElement("select")],
  ])("counts a focused %s as typing", async (_name, create) => {
    await mount(false);
    const field = create();
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await foreground();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => field.blur());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
