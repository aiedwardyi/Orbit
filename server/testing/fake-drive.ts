import { createHash } from "node:crypto";
import { z } from "zod";

import type { DriveFile } from "../drive-client.ts";

const metadataSchema = z.object({
  name: z.string().min(1), mimeType: z.string().optional(),
  parents: z.array(z.string()).default([]), appProperties: z.record(z.string(), z.string()).default({}),
});
interface RecordFile { file: DriveFile; bytes: Buffer; parents: string[] }
interface FilePage { files: DriveFile[]; nextPageToken?: string }
const json = (body: DriveFile | FilePage, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unquote = (value: string) => value.replace(/\\(.)/g, "$1");

export class FakeDrive {
  readonly records = new Map<string, RecordFile>();
  readonly calls: Array<{ method: string; url: URL }> = [];
  readonly uploads: Array<{ method: string; id: string; name: string; bytes: Buffer }> = [];
  readonly downloads: string[] = [];
  readonly responses: Array<Response | Error> = [];
  pageSize = 2;
  onCreate?: (file: DriveFile) => void | Promise<void>;
  onDownload?: (file: DriveFile) => void | Promise<void>;
  private tick = 1_800_000_000_000;
  private nextId = 1;

  add(name: string, properties: Record<string, string>, bytes = Buffer.alloc(0), parents: string[] = [], folder = false): DriveFile {
    const time = new Date(this.tick++).toISOString();
    const file: DriveFile = {
      id: `file-${this.nextId++}`, name, appProperties: { ...properties },
      mimeType: folder ? "application/vnd.google-apps.folder" : "application/octet-stream",
      createdTime: time, modifiedTime: time, trashed: false,
    };
    if (!folder) { file.md5Checksum = createHash("md5").update(bytes).digest("hex"); file.size = String(bytes.length); }
    this.records.set(file.id, { file, bytes: Buffer.from(bytes), parents: [...parents] });
    return structuredClone(file);
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
    if (request.method === "GET" && id === "files") {
      const q = url.searchParams.get("q") ?? "";
      let records = [...this.records.values()];
      if (q.includes("trashed = false")) records = records.filter(({ file }) => !file.trashed);
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
