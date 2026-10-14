// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { startUpload, UploadError, uploadErrorKey } from "./big-upload";

const ID = "0f0e0d0c-0b0a-4000-8000-000000000001";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = () => new File([new TextEncoder().encode("0123456789")], "meeting.mp4", { type: "video/mp4", lastModified: 7 });

describe("startUpload", () => {
  it("sends file.slice bodies and resumes from the server offset after a failed chunk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const arrayBuffer = vi.spyOn(Blob.prototype, "arrayBuffer");
    const chunks: Array<{ offset: number; body: unknown; size: number }> = [];
    let failed = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/uploads") {
        expect(JSON.parse(String(init?.body))).toEqual({ name: "meeting.mp4", size: 10, type: "video/mp4", lastModified: 7 });
        return Response.json({ id: ID, offset: 0, chunkBytes: 4 }, { status: 201 });
      }
      if (url === `/api/uploads/${ID}`) return Response.json({ offset: 6, size: 10, done: false });
      const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
      const body = init?.body;
      const size = body instanceof Blob ? body.size : -1;
      chunks.push({ offset, body, size });
      if (offset === 4 && !failed) {
        failed = true;
        throw new TypeError("network down");
      }
      const next = offset + size;
      return next === 10
        ? Response.json({ offset: 10, done: true, path: "C:\\Wink\\meeting.mp4", name: "meeting.mp4", size: 10, type: "video/mp4" })
        : Response.json({ offset: next });
    });
    vi.stubGlobal("fetch", fetcher);
    const phases: string[] = [];
    const run = startUpload(file(), { onPhase: (phase) => phases.push(phase) });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual({ path: "C:\\Wink\\meeting.mp4", name: "meeting.mp4", size: 10, type: "video/mp4" });
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4, 6]);
    expect(chunks.every((chunk) => chunk.body instanceof Blob)).toBe(true);
    expect(chunks.map((chunk) => chunk.size)).toEqual([4, 4, 4]);
    expect(fetcher).toHaveBeenCalledWith(`/api/uploads/${ID}`, expect.anything());
    expect(phases).toEqual(["resuming", "uploading"]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("deletes the session when aborted", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/uploads") return Promise.resolve(Response.json({ id: ID, offset: 0, chunkBytes: 4 }, { status: 201 }));
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const run = startUpload(file(), { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledWith(`/api/uploads/${ID}`, { method: "DELETE" });
  });

  it("maps a 507 disk_full to the disk-full message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "disk_full", error: "No space left" }, { status: 507 })));
    const run = startUpload(file());
    await expect(run).rejects.toBeInstanceOf(UploadError);
    await expect(run).rejects.toMatchObject({ key: "composer.uploadDiskFull" });
    expect(uploadErrorKey("too_big")).toBe("composer.uploadTooBig");
    expect(uploadErrorKey("busy")).toBe("composer.uploadBusy");
  });

  it("keeps one screen lock across a reconnect and takes a new one only after the browser drops it", async () => {
    class FakeSentinel extends EventTarget {
      released = false;
      release = vi.fn(async () => this.revoke());
      revoke() {
        this.released = true;
        this.dispatchEvent(new Event("release"));
      }
    }
    const locks: FakeSentinel[] = [];
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(async () => locks[locks.push(new FakeSentinel()) - 1]) },
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let chunks = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/uploads") return Response.json({ id: ID, offset: 0, chunkBytes: 16 }, { status: 201 });
      if (url === `/api/uploads/${ID}`) return Response.json({ offset: 0, size: 10, done: false });
      if (chunks++ < 2) {
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      }
      return Response.json({ offset: 10, done: true, path: "C:\\Wink\\meeting.mp4" });
    }));
    try {
      const run = startUpload(file());
      await vi.waitFor(() => expect(chunks).toBe(1));
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(chunks).toBe(2));
      expect(locks).toHaveLength(1);
      locks[0]!.revoke();
      document.dispatchEvent(new Event("visibilitychange"));
      await run;
      expect(locks).toHaveLength(2);
      expect(locks[0]!.release).not.toHaveBeenCalled();
      expect(locks[1]!.release).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, "wakeLock");
      Reflect.deleteProperty(document, "visibilityState");
    }
  });
});
