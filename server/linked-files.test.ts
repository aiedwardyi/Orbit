import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { serveLinkedFile, type LinkedMessage } from "./linked-files.ts";
import { requestCredentials } from "./phone-auth.ts";
import {
  loadThreadSyncLedger,
  markThreadDirty,
  messageWriter,
  pullThread,
  saveThreadSyncLedger,
  uploadThread,
  type LocalThread,
  type ThreadSyncHost,
} from "./thread-sync.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function isTcpAddress(address: string | AddressInfo | null): address is AddressInfo {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
  return address !== null && typeof address !== "string";
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!isTcpAddress(address)) return reject(new Error("no port"));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

describe("linked files", () => {
  it("refuses an unlinked path, escapes, a file outside the roots, a disallowed extension, and an unauthenticated request", async () => {
    const root = temp("linked-root-");
    const outside = temp("linked-out-");
    const secret = Buffer.from("secret-bytes");
    const clip = Buffer.from("0123456789abcdef");
    writeFileSync(join(root, "clip.mp4"), clip);
    writeFileSync(join(root, "other.mp4"), Buffer.from("not-linked"));
    writeFileSync(join(root, "notes.md"), Buffer.from("notes"));
    writeFileSync(join(outside, "secret.mp4"), secret);
    symlinkSync(outside, join(root, "escape"), "junction");
    const dotdot = `${root}${sep}..${sep}${basename(outside)}${sep}secret.mp4`;
    const messages: LinkedMessage[] = [
      { id: "m1", text: `[clip](${join(root, "clip.mp4")})` },
      { id: "m2", text: `[notes](${join(root, "notes.md")})` },
      { id: "m3", text: `[out](${join(outside, "secret.mp4")})` },
      { id: "m4", text: `[up](${dotdot})` },
      { id: "m5", text: `[link](${join(root, "escape", "secret.mp4")})` },
    ];
    const options = {
      bearerOk: true,
      remoteKey: "k",
      threadId: "t1",
      messages,
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    };
    const server = await listen((req, res) => serveLinkedFile(req, res, options));
    try {
      const get = (filePath: string) =>
        fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      const unlinked = await get(join(root, "other.mp4"));
      expect(unlinked.status).toBe(404);
      const up = await get(dotdot);
      expect(up.status).toBe(404);
      expect(Buffer.from(await up.arrayBuffer()).includes(secret)).toBe(false);
      const escaped = await get(join(root, "escape", "secret.mp4"));
      expect(escaped.status).toBe(404);
      expect(Buffer.from(await escaped.arrayBuffer()).includes(secret)).toBe(false);
      const outsideRes = await get(join(outside, "secret.mp4"));
      expect(outsideRes.status).toBe(404);
      expect(Buffer.from(await outsideRes.arrayBuffer()).includes(secret)).toBe(false);
      const ext = await get(join(root, "notes.md"));
      expect(ext.status).toBe(404);
      const denied = await listen((req, res) => serveLinkedFile(req, res, { ...options, bearerOk: false }));
      try {
        const unauth = await fetch(`${denied.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, "clip.mp4"))}`);
        expect(unauth.status).toBe(401);
        expect(Buffer.from(await unauth.arrayBuffer()).includes(clip)).toBe(false);
      } finally {
        await denied.close();
      }
    } finally {
      await server.close();
    }
  });

  it("serves a relay phone only on its phone session", async () => {
    const root = temp("linked-relay-");
    const clip = Buffer.from("relay-clip");
    writeFileSync(join(root, "clip.mp4"), clip);
    const base = {
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${join(root, "clip.mp4")})` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    };
    const cases: Array<[ReturnType<typeof requestCredentials>, number]> = [
      [requestCredentials(true, true, false, "k"), 200],
      // a relay request with the tailnet cookie or the boot token is still unauthenticated
      [requestCredentials(true, false, true, "k"), 401],
      // a phone session counts for nothing off the relay
      [requestCredentials(false, true, false, undefined), 401],
    ];
    for (const [credentials, status] of cases) {
      const server = await listen((req, res) => serveLinkedFile(req, res, { ...base, ...credentials }));
      try {
        const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, "clip.mp4"))}`, {
          headers: { cookie: "orbit_remote=k; __Host-wink_phone=wkd_x" },
        });
        expect(res.status).toBe(status);
        expect(Buffer.from(await res.arrayBuffer()).equals(clip)).toBe(status === 200);
      } finally {
        await server.close();
      }
    }
  });

  it("returns 206 with the requested bytes", async () => {
    const root = temp("linked-range-");
    const clip = Buffer.from("0123456789abcdef");
    const filePath = join(root, "clip.mp4");
    writeFileSync(filePath, clip);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${filePath})` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`, {
        headers: { Range: "bytes=2-5" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-5/16");
      expect(Buffer.from(await res.arrayBuffer()).equals(clip.subarray(2, 6))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("names the other PC when the linked file is not on this one", async () => {
    const root = temp("linked-remote-");
    const filePath = join(root, "clip.mp4");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${filePath})` }],
      deviceId: "this-pc",
      writerDeviceId: (id) => (id === "m1" ? "other-pc" : null),
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ deviceId: "other-pc" });
    } finally {
      await server.close();
    }
  });

  it("serves a Korean file name with an ASCII fallback and the file bytes", async () => {
    const root = temp("linked-ko-");
    const name = "한글 영상.mp4";
    const filePath = join(root, name);
    const clip = Buffer.from("korean-video-bytes");
    writeFileSync(filePath, clip);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](<${filePath}>)` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const url = `${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`;
      const full = await fetch(url);
      expect(full.status).toBe(200);
      const disposition = full.headers.get("content-disposition") ?? "";
      expect([...disposition].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
      expect(disposition).toContain("filename*=UTF-8''");
      expect(Buffer.from(await full.arrayBuffer()).equals(clip)).toBe(true);
      const ranged = await fetch(url, { headers: { Range: "bytes=0-5" } });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(clip.subarray(0, 6))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("ends the response when the file disappears before the stream opens", async () => {
    const root = temp("linked-vanish-");
    const filePath = join(root, "clip.mp4");
    writeFileSync(filePath, Buffer.from("0123456789abcdef"));
    const crashes: unknown[] = [];
    const onCrash = (error: Error) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    const server = await listen((req, res) => {
      serveLinkedFile(req, res, {
        bearerOk: true,
        remoteKey: undefined,
        threadId: "t1",
        messages: [{ id: "m1", text: `[clip](${filePath})` }],
        deviceId: "this-pc",
        writerDeviceId: () => null,
        rootsFor: () => [root],
      });
      unlinkSync(filePath);
    });
    try {
      const pending = fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`, {
        signal: AbortSignal.timeout(2000),
      });
      try {
        const res = await pending;
        await res.arrayBuffer();
      } catch {
        // a destroyed response still counts as ended
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
      await server.close();
    }
  });

  it("serves parenthesized names, titles, reference links, and angle-bracket paths", async () => {
    const root = temp("linked-md-");
    const nested = join(root, "My Files");
    mkdirSync(nested);
    const paren = Buffer.from("paren-bytes");
    const titled = Buffer.from("title-bytes");
    const referred = Buffer.from("ref-bytes");
    const spaced = Buffer.from("spaced-bytes");
    const hidden = Buffer.from("hidden-bytes");
    const encoded = Buffer.from("encoded-bytes");
    const parenPath = join(root, "clip(1).mp4");
    const titlePath = join(root, "title.mp4");
    const refPath = join(root, "ref.mp4");
    const spacedPath = join(nested, "clip (1).mp4");
    const hiddenPath = join(root, "secret.mp4");
    const encodedPath = join(nested, "영상 1.mp4");
    writeFileSync(parenPath, paren);
    writeFileSync(titlePath, titled);
    writeFileSync(refPath, referred);
    writeFileSync(spacedPath, spaced);
    writeFileSync(hiddenPath, hidden);
    writeFileSync(encodedPath, encoded);
    const messages: LinkedMessage[] = [
      { id: "m1", text: `[clip](${parenPath})` },
      { id: "m2", text: `[x](${titlePath} "Preview")` },
      { id: "m3", text: `[x][v]\n\n[v]: ${refPath}` },
      { id: "m4", text: `[clip](<${spacedPath}>)` },
      { id: "m5", text: `see \`[clip](${hiddenPath})\` later` },
      { id: "m6", text: `[clip](${pathToFileURL(encodedPath).href})` },
    ];
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages,
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const get = async (filePath: string) => {
        const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
        return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
      };
      const parenRes = await get(parenPath);
      expect(parenRes.status).toBe(200);
      expect(parenRes.bytes.equals(paren)).toBe(true);
      const titleRes = await get(titlePath);
      expect(titleRes.status).toBe(200);
      expect(titleRes.bytes.equals(titled)).toBe(true);
      const refRes = await get(refPath);
      expect(refRes.status).toBe(200);
      expect(refRes.bytes.equals(referred)).toBe(true);
      const spacedRes = await get(spacedPath);
      expect(spacedRes.status).toBe(200);
      expect(spacedRes.bytes.equals(spaced)).toBe(true);
      const hiddenRes = await get(hiddenPath);
      expect(hiddenRes.status).toBe(404);
      expect(hiddenRes.bytes.includes(hidden)).toBe(false);
      const encodedRes = await get(encodedPath);
      expect(encodedRes.status).toBe(200);
      expect(encodedRes.bytes.equals(encoded)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("still names the PC that holds the file after the other PC reacts", async () => {
    const folder = temp("linked-react-");
    const filePath = join(folder, "clip.mp4");
    const bot = "sync-bot-1";
    const pc = (deviceId: string) => {
      const dataDir = temp(`linked-react-${deviceId}-`);
      const threads = new Map<string, LocalThread>();
      const host: ThreadSyncHost = {
        folder,
        dataDir,
        deviceId,
        ledger: loadThreadSyncLedger(dataDir),
        saveLedger: () => saveThreadSyncLedger(dataDir, host.ledger),
        local: (threadId) => threads.get(threadId) ?? null,
        running: () => false,
        adopt: (_botId, file) => {
          threads.set(file.task.threadId, {
            title: file.task.title,
            createdAt: file.task.createdAt,
            messages: structuredClone(file.messages),
            activeLeafId: file.activeLeafId,
          });
        },
        remove: (_botId, threadId) => void threads.delete(threadId),
        conflicted: () => {},
        now: () => 1_700_000_000_500,
      };
      return { host, dataDir, threads };
    };
    const work = pc("work");
    const home = pc("home");
    work.threads.set("t1", {
      title: "Clip",
      createdAt: 1_700_000_000_000,
      activeLeafId: "m1",
      messages: [{
        id: "m1",
        role: "bot",
        kind: "text",
        text: `[clip](${filePath})`,
        at: 1_700_000_000_000,
        parentId: null,
      }],
    });
    expect(uploadThread(work.host, bot, "t1")).toBe("written");
    expect(pullThread(home.host, "bot", bot, "t1")).toBe("imported");
    const local = home.threads.get("t1")!;
    local.messages = local.messages.map((message) => (
      message.id === "m1" ? { ...message, reactions: [{ emoji: "👍", by: "user" }] } : message
    ));
    markThreadDirty(home.host.ledger, "t1");
    home.host.saveLedger();
    expect(uploadThread(home.host, bot, "t1")).toBe("written");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: home.threads.get("t1")!.messages.map((message) => ({ id: message.id, text: message.text })),
      deviceId: "home",
      writerDeviceId: (messageId) => messageWriter(home.dataDir, "t1", messageId),
      rootsFor: () => [folder],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found", deviceId: "work" });
    } finally {
      await server.close();
    }
  });
});
