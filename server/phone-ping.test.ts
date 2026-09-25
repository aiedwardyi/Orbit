import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "./notify.ts";
import {
  PHONE_PING_FILE,
  PHONE_PING_TIMEOUT_MS,
  createPingLimiter,
  loadPhonePingTopic,
  parsePhonePingTopic,
  pingForMailbox,
  pingForNotification,
  savePhonePingTopic,
  sendPhonePing,
} from "./phone-ping.ts";

const frame = (kind: Notification["kind"]): Notification => ({
  kind,
  botId: "bot-1",
  botName: "Scout",
  threadId: "thread-1",
  title: `Scout ${kind}`,
  body: "detail",
});

describe("parsePhonePingTopic", () => {
  it("treats empty as off", () => {
    expect(parsePhonePingTopic("")).toEqual({ ok: true, target: null });
    expect(parsePhonePingTopic("   ")).toEqual({ ok: true, target: null });
  });

  it("sends a bare topic to ntfy.sh", () => {
    expect(parsePhonePingTopic(" orbit_Ping-1 ")).toEqual({ ok: true, target: { base: "https://ntfy.sh", topic: "orbit_Ping-1" } });
  });

  it("keeps the host and path prefix of a full URL", () => {
    expect(parsePhonePingTopic("https://ntfy.example.com/alerts")).toEqual({
      ok: true,
      target: { base: "https://ntfy.example.com", topic: "alerts" },
    });
    expect(parsePhonePingTopic("https://example.com/ntfy/alerts/")).toEqual({
      ok: true,
      target: { base: "https://example.com/ntfy", topic: "alerts" },
    });
  });

  it("rejects bad topics and non-https URLs", () => {
    for (const bad of [
      "has space",
      "a".repeat(65),
      "emoji🙂",
      "http://ntfy.sh/topic",
      "https://ntfy.sh/",
      "https://ntfy.sh/bad.topic",
      "https://user:pw@ntfy.sh/topic",
      "https://ntfy.sh/topic?x=1",
      "ftp://ntfy.sh/topic",
    ]) {
      expect(parsePhonePingTopic(bad).ok, bad).toBe(false);
    }
    expect(parsePhonePingTopic("a".repeat(64)).ok).toBe(true);
  });
});

describe("phone ping file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-phone-ping-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrips the topic and defaults to off", () => {
    expect(loadPhonePingTopic(dir)).toBe("");
    savePhonePingTopic(dir, " my-topic ");
    expect(loadPhonePingTopic(dir)).toBe("my-topic");
  });

  it("ignores a corrupt or invalid file", () => {
    writeFileSync(join(dir, PHONE_PING_FILE), "{nope");
    expect(loadPhonePingTopic(dir)).toBe("");
    writeFileSync(join(dir, PHONE_PING_FILE), JSON.stringify({ topic: "http://insecure/x" }));
    expect(loadPhonePingTopic(dir)).toBe("");
  });
});

describe("pingForNotification", () => {
  it("always pings when a bot is blocked on you", () => {
    for (const kind of ["approval", "question", "takeover"] as const) {
      expect(pingForNotification(frame(kind))).toEqual({ title: `Scout ${kind}`, message: "detail", priority: 4 });
    }
    expect(pingForNotification(frame("routine-failed"))).toEqual({ title: "Scout routine-failed", message: "detail" });
  });

  it("pings done only for turns of 60 s or longer", () => {
    expect(pingForNotification(frame("done"))).toBeNull();
    expect(pingForNotification(frame("done"), 59_999)).toBeNull();
    expect(pingForNotification(frame("done"), 60_000)).toEqual({ title: "Scout done", message: "detail" });
  });
});

describe("pingForMailbox", () => {
  it("pings FAIL and BLOCKED reports with the first line", () => {
    expect(pingForMailbox("Scout", "FAIL PHONE-PING branch=x sha=abc dirty=no\nlong detail")).toEqual({
      title: "Scout: worker FAIL",
      message: "FAIL PHONE-PING branch=x sha=abc dirty=no",
      tags: ["warning"],
    });
    expect(pingForMailbox("Scout", "BLOCKED NICK branch=none\r\nwhy")?.title).toBe("Scout: worker BLOCKED");
  });

  it("stays quiet for DONE reports and plain notes", () => {
    expect(pingForMailbox("Scout", "DONE NICK branch=x sha=y dirty=no\nall good")).toBeNull();
    expect(pingForMailbox("Scout", "the build FAILed")).toBeNull();
    expect(pingForMailbox("Scout", "FAILED to start")).toBeNull();
    expect(pingForMailbox("Scout", "")).toBeNull();
  });
});

describe("createPingLimiter", () => {
  it("drops a repeat title per bot within 10 s", () => {
    let now = 0;
    const allow = createPingLimiter(10_000, () => now);
    expect(allow("bot-1", "Scout finished")).toBe(true);
    expect(allow("bot-1", "Scout finished")).toBe(false);
    expect(allow("bot-1", "Scout has a question")).toBe(true);
    expect(allow("bot-2", "Scout finished")).toBe(true);
    now = 9_999;
    expect(allow("bot-1", "Scout finished")).toBe(false);
    now = 10_000;
    expect(allow("bot-1", "Scout finished")).toBe(true);
  });
});

describe("sendPhonePing", () => {
  const target = { base: "https://ntfy.sh", topic: "topic-1" };

  it("POSTs JSON with the topic, title and message", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await sendPhonePing(target, { title: "Scöut needs approval", message: "rm -rf", priority: 4 }, fetchImpl);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ topic: "topic-1", title: "Scöut needs approval", message: "rm -rf", priority: 4 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(PHONE_PING_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it("never throws on a network error and logs one line", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    await expect(sendPhonePing(target, { title: "t", message: "m" }, fetchImpl, warn)).resolves.toEqual({
      ok: false,
      error: "getaddrinfo ENOTFOUND",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports a non-2xx answer", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    await expect(sendPhonePing(target, { title: "t", message: "m" }, fetchImpl, warn)).resolves.toEqual({
      ok: false,
      error: "ntfy answered 429",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives up on a hung server at the timeout", async () => {
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = sendPhonePing(target, { title: "t", message: "m" }, fetchImpl, () => {});
    clock.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(pending).resolves.toMatchObject({ ok: false });
    timeout.mockRestore();
  });
});
