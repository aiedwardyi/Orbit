// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dropUpload, uploadJobs } from "@/lib/big-upload";
import { fileAttachment, uploadAttachment } from "@/lib/composer-attachments";
import { getDraftAttachments, setDraftAttachments } from "@/lib/drafts";
import { onHoldReleased, reloadHeld } from "@/lib/reload-hold";
import { StoreProvider } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  onmessage: (() => void) | null = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  for (const id of uploadJobs().keys()) dropUpload(id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountComposer() {
  let answer!: () => void;
  const uploaded = new Promise<void>((resolve) => (answer = resolve));
  const fetch = vi.fn(async (url: string) => {
    if (!String(url).includes("/api/attachments")) return Response.json({ error: "not in this test" }, { status: 404 });
    await uploaded;
    return Response.json({ path: "/tmp/shot.png", mime: "image/png", bytes: 3 });
  });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Composer, {}))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const uploads = () => fetch.mock.calls.filter(([url]) => String(url).includes("/api/attachments")).length;
  return { host, answer, uploads };
}

const image = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

const intakes: Array<[string, (host: HTMLElement) => void]> = [
  ["paste", (host) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [image()], getData: () => "" } });
    host.querySelector("textarea")!.dispatchEvent(event);
  }],
  ["pick", (host) => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [image()], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }],
  ["drop", () => {
    const event = new Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [image()] } });
    window.dispatchEvent(event);
  }],
];

describe("update reload during an upload", () => {
  it.each(intakes)("%s holds the reload until the chip is in the draft", async (_name, intake) => {
    const { host, answer, uploads } = await mountComposer();
    await act(async () => intake(host));
    await vi.waitFor(() => expect(uploads()).toBe(1));
    expect(reloadHeld()).toBe(true);
    let draftAtRelease: string | null = null;
    const stop = onHoldReleased(() => {
      draftAtRelease = localStorage.getItem("omb-draft-attachments");
    });
    await act(async () => answer());
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    stop();
    expect(draftAtRelease).toContain("/tmp/shot.png");
    expect(host.querySelector('[aria-label="Remove file"]')).not.toBeNull();
  });
});

describe("big file upload", () => {
  it("blocks Send while the upload runs and allows it once the chip is a file", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const id = "0f0e0d0c-0b0a-4000-8000-000000000002";
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/uploads") return Response.json({ id, offset: 0, chunkBytes: 8388608 }, { status: 201 });
      if (String(url).startsWith(`/api/uploads/${id}/chunk`)) {
        await finished;
        return Response.json({ offset: 3, done: true, path: "/pc/Wink/clip.mp4", name: "clip.mp4", size: 3, type: "video/mp4" });
      }
      return Response.json({ error: "not in this test" }, { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Composer, {}))));
    unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const clip = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(input, "files", { value: [clip], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const sendButton = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('button[title="Send after the upload finishes"]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(sendButton.disabled).toBe(true);
    expect(host.textContent).toContain("clip.mp4");
    await act(async () => finish());
    await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
    expect(host.querySelector('[aria-label="Remove file"]')).not.toBeNull();
    expect(localStorage.getItem("omb-draft-attachments")).toContain("/pc/Wink/clip.mp4");
  });
});

describe("big file recovery", () => {
  const id = "0f0e0d0c-0b0a-4000-8000-000000000003";
  const newId = "0f0e0d0c-0b0a-4000-8000-000000000004";
  const clip = () => new File(["0123456789"], "clip.mp4", { type: "video/mp4", lastModified: 7 });
  const finished = (path = "/pc/Wink/clip.mp4") => Response.json({ offset: 10, done: true, path, name: "clip.mp4", size: 10, type: "video/mp4" });
  const draft = () => getDraftAttachments(localStorage, "bot::");

  async function mount(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
    const routes: string[] = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      routes.push(`${init?.method ?? "GET"} ${url}`);
      return fetch(url, init);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Composer, {}))));
    unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, routes };
  }

  async function pick(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  it.each([false, true])("stores the finished file before the reload hold lets go (unmounted: %s)", async (away) => {
    let finish!: () => void;
    const last = new Promise<void>((resolve) => (finish = resolve));
    const { host, routes } = await mount(async (url) => {
      if (url === "/api/uploads") return Response.json({ id, offset: 0, chunkBytes: 8388608 }, { status: 201 });
      await last;
      return finished();
    });
    await pick(host.querySelector<HTMLInputElement>('input[type="file"]')!, clip());
    await vi.waitFor(() => expect(routes).toContain(`POST /api/uploads/${id}/chunk?offset=0`));
    if (away) {
      await unmount?.();
      unmount = null;
    }
    let draftAtRelease: unknown[] = [];
    const stop = onHoldReleased(() => (draftAtRelease = draft()));
    await act(async () => finish());
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    stop();
    expect(draftAtRelease).toEqual([expect.objectContaining({ kind: "file", path: "/pc/Wink/clip.mp4", uploadId: id })]);
  });

  it.each([
    ["done", () => finished(), [`GET /api/uploads/${id}`], id],
    ["partial", () => Response.json({ offset: 6, size: 10, done: false }), [`GET /api/uploads/${id}`, `POST /api/uploads/${id}/chunk?offset=6`], id],
    [
      "gone",
      () => Response.json({ code: "gone" }, { status: 404 }),
      [`GET /api/uploads/${id}`, "POST /api/uploads", `POST /api/uploads/${newId}/chunk?offset=0`],
      newId,
    ],
  ] as const)("re-picking a %s upload asks its saved session first", async (_name, saved, expected, uploadId) => {
    const old = uploadAttachment(clip());
    old.uploadId = id;
    setDraftAttachments(localStorage, "bot::", [old]);
    const { host, routes } = await mount(async (url) => {
      if (url === `/api/uploads/${id}`) return saved();
      if (url === "/api/uploads") return Response.json({ id: newId, offset: 0, chunkBytes: 8388608 }, { status: 201 });
      return finished();
    });
    const repick = [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick the file again to resume")!;
    await act(async () => repick.click());
    await pick(host.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!, clip());
    await vi.waitFor(() => expect(draft()).toEqual([expect.objectContaining({ kind: "file", path: "/pc/Wink/clip.mp4", uploadId })]));
    expect(routes).toEqual(expected);
  });

  it("removing a finished file chip leaves the file on the PC", async () => {
    const sent = fileAttachment("clip.mp4", "/pc/Wink/clip.mp4", 10, "video/mp4");
    sent.uploadId = id;
    setDraftAttachments(localStorage, "bot::", [sent]);
    const { host, routes } = await mount(async () => new Response(null, { status: 204 }));
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Remove file"]')!.click());
    expect(draft()).toEqual([]);
    expect(routes).toEqual([]);
  });
});
