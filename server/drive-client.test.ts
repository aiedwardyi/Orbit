import { describe, expect, it, vi } from "vitest";

import { createDriveClient, DriveClientError } from "./drive-client.ts";
import { FakeDrive } from "./testing/fake-drive.ts";

function clientFor(drive: FakeDrive) {
  return createDriveClient({ getAccessToken: async () => "test-access", fetch: drive.fetch });
}

describe("Drive client", () => {
  it("finds the tagged root across pages instead of matching its name", async () => {
    const drive = new FakeDrive();
    drive.pageSize = 1;
    drive.add("Wink sync (managed by Wink)", {}, undefined, [], true);
    const first = drive.add("Renamed root", { winkRoot: "1" }, undefined, [], true);
    drive.add("Second root", { winkRoot: "1" }, undefined, [], true);
    expect((await clientFor(drive).findOrCreateRoot()).id).toBe(first.id);
    expect(drive.calls.every((call) => call.method === "GET")).toBe(true);
    expect(drive.calls[0].url.searchParams.get("q")).toContain("appProperties has { key='winkRoot' and value='1' }");
  });

  it("creates one tagged root and finds it on the next sign-in", async () => {
    const drive = new FakeDrive();
    const root = await clientFor(drive).findOrCreateRoot();
    expect(root.name).toBe("Wink sync (managed by Wink)");
    expect(root.appProperties).toEqual({ winkRoot: "1" });
    expect((await clientFor(drive).findOrCreateRoot()).id).toBe(root.id);
    expect(drive.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("pages every child with its checksum, size and timestamps", async () => {
    const drive = new FakeDrive();
    const root = drive.root();
    const files = Array.from({ length: 5 }, (_, i) => drive.add(`name-${i}`, { ph: `hash-${i}` }, Buffer.from(String(i)), [root.id]));
    drive.add("outside", {}, Buffer.from("other"));
    const trashed = drive.add("trashed", {}, Buffer.from("old"), [root.id]);
    drive.records.get(trashed.id)!.file.trashed = true;
    expect(await clientFor(drive).listChildren(root.id)).toEqual(files);
    expect(drive.calls).toHaveLength(3);
    expect(drive.calls[0].url.searchParams.get("fields")).toContain("md5Checksum,size,createdTime,modifiedTime,trashed");
  });

  it("escapes quotes and backslashes in the parent query", async () => {
    const drive = new FakeDrive();
    const root = drive.root();
    const record = drive.records.get(root.id)!;
    const id = "root'\\quoted";
    drive.records.set(id, { ...record, file: { ...record.file, id } });
    const file = drive.add("child", {}, Buffer.from("data"), [id]);
    expect(await clientFor(drive).listChildren(id)).toEqual([file]);
  });

  it("round-trips multipart binary media and private properties", async () => {
    const drive = new FakeDrive();
    const root = drive.root();
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
    const client = clientFor(drive);
    const created = await client.createFile(root.id, "pictures%2F%ED%95%9C.png", { ph: "a".repeat(32) }, bytes);
    expect(created.appProperties).toEqual({ ph: "a".repeat(32) });
    expect(created.size).toBe(String(bytes.length));
    expect(await client.downloadFile(created.id)).toEqual(bytes);
    expect(drive.calls[0].url.searchParams.get("uploadType")).toBe("multipart");
    expect(drive.calls[1].url.searchParams.get("alt")).toBe("media");
  });

  it("updates media without changing its id, name or properties", async () => {
    const drive = new FakeDrive();
    const file = drive.add("devices%2Fhome.json", { ph: "hash" }, Buffer.from("old"), [drive.root().id]);
    const client = clientFor(drive);
    const updated = await client.updateMedia(file.id, Buffer.from("new"));
    expect(updated.id).toBe(file.id);
    expect(updated.name).toBe(file.name);
    expect(updated.appProperties).toEqual(file.appProperties);
    expect(updated.md5Checksum).not.toBe(file.md5Checksum);
    expect(await client.downloadFile(file.id)).toEqual(Buffer.from("new"));
    expect(drive.calls[0].method).toBe("PATCH");
  });

  it("allows duplicate names without compare-and-swap", async () => {
    const drive = new FakeDrive();
    const root = drive.root();
    const client = clientFor(drive);
    const first = await client.createFile(root.id, "same", { ph: "same" }, Buffer.from("first"));
    const second = await client.createFile(root.id, "same", { ph: "same" }, Buffer.from("second"));
    expect(first.id).not.toBe(second.id);
    expect(await client.listChildren(root.id)).toHaveLength(2);
  });

  it("asks the injected token provider before each request", async () => {
    const drive = new FakeDrive();
    const getAccessToken = vi.fn(async () => "test-access");
    const client = createDriveClient({ getAccessToken, fetch: async (input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(true);
      return drive.fetch(input, init);
    } });
    await client.findOrCreateRoot();
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 429, 500])("returns a typed HTTP %i error without retry or response text", async (status) => {
    const drive = new FakeDrive();
    drive.responses.push(new Response("private response text", { status }));
    const error = await clientFor(drive).listChildren("root").catch((error) => error);
    expect(error).toBeInstanceOf(DriveClientError);
    expect(error.status).toBe(status);
    expect(error.message).toBe(`Drive request failed (HTTP ${status})`);
    expect(drive.calls).toHaveLength(1);
  });

  it("redacts network and token-provider failures", async () => {
    const drive = new FakeDrive();
    drive.responses.push(new Error("private network detail"));
    await expect(clientFor(drive).listChildren("root")).rejects.toMatchObject({ status: 0, message: "Drive request failed (HTTP 0)" });
    const client = createDriveClient({ getAccessToken: async () => { throw new Error("private credential detail"); }, fetch: drive.fetch });
    await expect(client.listChildren("root")).rejects.toMatchObject({ status: 0, message: "Drive request failed (HTTP 0)" });
    expect(drive.calls).toHaveLength(1);
  });

  it.each(["not json", JSON.stringify({ files: [{}] })])("rejects an unusable successful list", async (body) => {
    const drive = new FakeDrive();
    drive.responses.push(new Response(body));
    await expect(clientFor(drive).listChildren("root")).rejects.toMatchObject({ status: 200 });
    expect(drive.calls).toHaveLength(1);
  });

  it("reports an incomplete search with its own error type", async () => {
    const drive = new FakeDrive();
    drive.responses.push(new Response('{"files":[],"incompleteSearch":true}'));
    const error = await clientFor(drive).listChildren("root").catch((error) => error);
    expect(error).toMatchObject({ name: "DriveIncompleteSearchError", message: "Drive search is incomplete" });
    expect(error.status).toBeUndefined();
    expect(drive.calls).toHaveLength(1);
  });

  it("sizes transfer timeouts by bytes and leaves metadata at 30 seconds", async () => {
    const drive = new FakeDrive();
    const root = drive.root();
    const client = clientFor(drive);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await client.listChildren(root.id);
      const bytes = new Uint8Array(65_536);
      const file = await client.createFile(root.id, "pictures%2Fa.png", {}, bytes);
      await client.updateMedia(file.id, bytes);
      await client.downloadFile(file.id, "5242880");
      await client.downloadFile(file.id, "999999999999999999999999");
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 32_000, 31_000, 110_000, 2_147_483_647]);
    } finally { timeout.mockRestore(); }
  });

  it("reports a failed download body as a transport error", async () => {
    const drive = new FakeDrive();
    drive.responses.push(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body detail")); } })));
    await expect(clientFor(drive).downloadFile("file")).rejects.toMatchObject({ status: 0, message: "Drive request failed (HTTP 0)" });
  });

  it.each(["create", "update"])("reports a failed %s response body as a transport error", async (kind) => {
    const drive = new FakeDrive();
    const root = drive.root();
    drive.responses.push(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body detail")); } })));
    const client = clientFor(drive);
    const result = kind === "create" ? client.createFile(root.id, "pictures%2Fa.png", {}, Buffer.from("data")) : client.updateMedia("file", Buffer.from("data"));
    await expect(result).rejects.toMatchObject({ status: 0, message: "Drive request failed (HTTP 0)" });
  });

  it("stops a repeating page token", async () => {
    const drive = new FakeDrive();
    drive.responses.push(new Response('{"files":[],"nextPageToken":"same"}'), new Response('{"files":[],"nextPageToken":"same"}'));
    await expect(clientFor(drive).listChildren("root")).rejects.toMatchObject({ status: 200 });
    expect(drive.calls).toHaveLength(2);
  });

  it("cancels a 429 response body", async () => {
    const drive = new FakeDrive();
    const response = new Response("private", { status: 429, headers: { "retry-after": "2" } });
    const body = response.body;
    if (!body) throw new Error("missing body");
    const cancel = vi.spyOn(body, "cancel");
    drive.responses.push(response);
    await expect(clientFor(drive).listChildren("root")).rejects.toMatchObject({ status: 429, rateLimited: true, retryAfterMs: 2_000 });
    expect(cancel).toHaveBeenCalled();
  });

  it("reads storageQuotaExceeded as a full Drive in any domain, never a rate limit", async () => {
    const drive = new FakeDrive();
    const reply = (domain: string, reason: string) => Response.json({ error: { errors: [{ domain, reason }] } }, { status: 403, headers: { "retry-after": "2" } });
    drive.responses.push(reply("global", "storageQuotaExceeded"), reply("usageLimits", "storageQuotaExceeded"), reply("usageLimits", "userRateLimitExceeded"));
    const client = clientFor(drive);
    await expect(client.updateMedia("file-1", Buffer.from("x"))).rejects.toMatchObject({ status: 403, driveFull: true, rateLimited: false, retryAfterMs: null });
    await expect(client.createFile("root", "a", {}, Buffer.from("x"))).rejects.toMatchObject({ status: 403, driveFull: true, rateLimited: false, retryAfterMs: null });
    await expect(client.updateMedia("file-1", Buffer.from("x"))).rejects.toMatchObject({ status: 403, driveFull: false, rateLimited: true, retryAfterMs: 2_000 });
  });

  it("stops a change page that repeats its page token", async () => {
    const drive = new FakeDrive();
    const page = JSON.stringify({ changes: [], nextPageToken: "start" });
    drive.responses.push(new Response(page), new Response(page));
    await expect(clientFor(drive).listChanges("start")).rejects.toMatchObject({ status: 200 });
    expect(drive.calls).toHaveLength(1);
  });

  it("skips a non-file change and advances the cursor", async () => {
    const drive = new FakeDrive();
    const file = {
      id: "file-1", name: "devices%2Fdevice-work.json", mimeType: "application/octet-stream",
      createdTime: "2026-01-01T00:00:00.000Z", modifiedTime: "2026-01-01T00:00:00.000Z", trashed: false, parents: ["root-1"],
    };
    drive.responses.push(new Response(JSON.stringify({
      changes: [{ changeType: "drive", driveId: "shared-1" }, { fileId: file.id, file }],
      newStartPageToken: "cursor-2",
    })));
    const page = await clientFor(drive).listChanges("cursor-1");
    expect(page.newStartPageToken).toBe("cursor-2");
    expect(page.changes.map((change) => change.fileId)).toEqual([file.id]);
    expect(page.changes[0]?.parents).toEqual(["root-1"]);
    expect(page.changes[0]?.file?.name).toBe(file.name);
  });
});
