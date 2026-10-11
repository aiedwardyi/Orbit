import { createHash } from "node:crypto";
import { z } from "zod";

import type { DriveFile } from "../drive-client.ts";

const metadataSchema = z.object({
  name: z.string().min(1), mimeType: z.string().optional(),
  parents: z.array(z.string()).default([]), appProperties: z.record(z.string(), z.string()).default({}),
});
interface RecordFile { file: DriveFile; bytes: Buffer; parents: string[] }
interface FilePage { files: DriveFile[]; nextPageToken?: string }
interface ChangeRecord { at: number; fileId: string; removed: boolean; file?: DriveFile; parents: string[] }
const json = (body: DriveFile | FilePage | { startPageToken: string } | { changes: Array<{ fileId: string; removed: boolean; file?: DriveFile & { parents: string[] } }>; nextPageToken?: string; newStartPageToken?: string }, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unquote = (value: string) => value.replace(/\\(.)/g, "$1");

export class FakeDrive {
  readonly records = new Map<string, RecordFile>();
  readonly calls: Array<{ method: string; url: URL }> = [];
  readonly uploads: Array<{ method: string; id: string; name: string; bytes: Buffer }> = [];
  readonly downloads: string[] = [];
  readonly responses: Array<Response | Error> = [];
  pageSize = 2;
  missGets = 0;
  readonly hiddenFromSearch = new Set<string>();
  onCreate?: (file: DriveFile) => void | Promise<void>;
  onDownload?: (file: DriveFile) => void | Promise<void>;
  private tick = 1_800_000_000_000;
  private nextId = 1;
  private cursor = 0;
  private history: ChangeRecord[] = [];

  add(name: string, properties: Record<string, string>, bytes = Buffer.alloc(0), parents: string[] = [], folder = false): DriveFile {
    const time = new Date(this.tick++).toISOString();
    const file: DriveFile = {
      id: `file-${this.nextId++}`, name, appProperties: { ...properties },
      mimeType: folder ? "application/vnd.google-apps.folder" : "application/octet-stream",
      createdTime: time, modifiedTime: time, trashed: false,
    };
    if (!folder) { file.md5Checksum = createHash("md5").update(bytes).digest("hex"); file.size = String(bytes.length); }
    this.records.set(file.id, { file, bytes: Buffer.from(bytes), parents: [...parents] });
    this.note(file.id);
    return structuredClone(file);
  }

  trash(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.file.trashed = true;
    this.note(id);
  }

  remove(id: string): void {
    if (!this.records.has(id)) return;
    this.note(id, true);
    this.records.delete(id);
  }

  private note(id: string, removed = false): void {
    this.cursor += 1;
    const record = this.records.get(id);
    this.history.push({
      at: this.cursor, fileId: id, removed, parents: record ? [...record.parents] : [],
      file: record ? structuredClone(record.file) : undefined,
    });
  }

  root(): DriveFile {
    const root = [...this.records.values()].find(({ file }) => file.appProperties?.winkRoot === "1" && !file.trashed);
    return root ? structuredClone(root.file) : this.add("Wink sync (managed by Wink)", { winkRoot: "1" }, undefined, [], true);
  }

  edit(id: string, bytes: Buffer): DriveFile {
    const record = this.records.get(id)!;
    record.bytes = Buffer.from(bytes);
    record.file.md5Checksum = createHash("md5").update(bytes).digest("hex");
    record.file.size = String(bytes.length);
    record.file.modifiedTime = new Date(this.tick++).toISOString();
    this.note(id);
    return structuredClone(record.file);
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({ method: request.method, url });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response) return response;
    if (url.origin !== "https://www.googleapis.com") throw new Error("Unexpected fake Drive origin");
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (request.method === "GET" && url.pathname === "/drive/v3/changes/startPageToken") return json({ startPageToken: String(this.cursor) });
    if (request.method === "GET" && url.pathname === "/drive/v3/changes") {
      const token = url.searchParams.get("pageToken") ?? "";
      const page = /^p:(\d+):(\d+)$/.exec(token);
      const since = page ? Number(page[1]) : /^\d+$/.test(token) ? Number(token) : NaN;
      const offset = page ? Number(page[2]) : 0;
      if (!Number.isInteger(since) || since < 0 || since > this.cursor || !Number.isInteger(offset) || offset < 0) return new Response(null, { status: 404 });
      const pending = this.history.filter((change) => change.at > since);
      const slice = pending.slice(offset, offset + this.pageSize);
      const changes = slice.map((change) => ({
        fileId: change.fileId, removed: change.removed,
        file: change.file ? { ...change.file, parents: change.parents } : undefined,
      }));
      if (offset + this.pageSize < pending.length) return json({ changes, nextPageToken: `p:${since}:${offset + this.pageSize}` });
      return json({ changes, newStartPageToken: String(this.cursor) });
    }
    if (request.method === "GET" && id === "files") {
      const q = url.searchParams.get("q") ?? "";
      let records = [...this.records.values()].filter(({ file }) => !this.hiddenFromSearch.has(file.id));
      if (q.includes("trashed = false")) records = records.filter(({ file }) => !file.trashed);
      const named = /(?:^| )name = '((?:\\.|[^'])*)'/.exec(q);
      if (named) records = records.filter(({ file }) => file.name === unquote(named[1]));
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) records = records.filter(({ file }) => file.mimeType === "application/vnd.google-apps.folder");
      const property = /key\s*=\s*'((?:\\.|[^'])*)'\s+and\s+value\s*=\s*'((?:\\.|[^'])*)'/.exec(q);
      if (property) records = records.filter(({ file }) => file.appProperties?.[unquote(property[1])] === unquote(property[2]));
      const parent = /'((?:\\.|[^'])*)' in parents/.exec(q);
      if (parent) {
        const root = this.records.get(unquote(parent[1]));
        if (!root || root.file.trashed) return new Response(null, { status: 404 });
        records = records.filter((record) => record.parents.includes(unquote(parent[1])));
      }
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const end = start + this.pageSize;
      const page: FilePage = { files: records.slice(start, end).map(({ file }) => file) };
      if (end < records.length) page.nextPageToken = String(end);
      return json(page);
    }
    if (request.method === "GET" && url.searchParams.get("alt") !== "media" && id !== "files") {
      if (this.missGets > 0) { this.missGets -= 1; return new Response(null, { status: 404 }); }
      const record = this.records.get(id);
      if (!record) return new Response(null, { status: 404 });
      return json(record.file);
    }
    if (request.method === "GET" && url.searchParams.get("alt") === "media") {
      const record = this.records.get(id);
      if (!record || record.file.trashed) return new Response(null, { status: 404 });
      this.downloads.push(id);
      const bytes = Buffer.from(record.bytes);
      await this.onDownload?.(structuredClone(record.file));
      return new Response(new Uint8Array(bytes));
    }
    if (request.method === "POST") {
      let metadata: z.infer<typeof metadataSchema>;
      let bytes = Buffer.alloc(0);
      const folder = url.pathname === "/drive/v3/files";
      if (folder) metadata = metadataSchema.parse(await request.json());
      else {
        const boundary = /boundary=(.+)$/.exec(request.headers.get("content-type") ?? "")?.[1];
        if (!boundary || url.searchParams.get("uploadType") !== "multipart") throw new Error("Invalid fake multipart upload");
        const body = Buffer.from(await request.arrayBuffer());
        const start = body.indexOf("\r\n\r\n") + 4;
        const divider = body.indexOf(`\r\n--${boundary}`, start);
        metadata = metadataSchema.parse(JSON.parse(body.subarray(start, divider).toString("utf8")));
        const mediaStart = body.indexOf("\r\n\r\n", divider) + 4;
        const mediaEnd = body.indexOf(`\r\n--${boundary}--`, mediaStart);
        if (divider < 0 || mediaEnd < 0) throw new Error("Invalid fake multipart body");
        bytes = Buffer.from(body.subarray(mediaStart, mediaEnd));
      }
      const file = this.add(metadata.name, metadata.appProperties, bytes, metadata.parents, folder);
      if (!folder) this.uploads.push({ method: request.method, id: file.id, name: file.name, bytes });
      await this.onCreate?.(file);
      return json(file);
    }
    if (request.method === "PATCH" && url.searchParams.get("uploadType") === "media") {
      if (!this.records.has(id)) return new Response(null, { status: 404 });
      const bytes = Buffer.from(await request.arrayBuffer());
      const file = this.edit(id, bytes);
      this.uploads.push({ method: request.method, id, name: file.name, bytes });
      return json(file);
    }
    throw new Error(`Unexpected fake Drive method ${request.method}`);
  };
}
