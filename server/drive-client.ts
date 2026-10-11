import { randomUUID } from "node:crypto";
import { z } from "zod";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,appProperties,md5Checksum,size,createdTime,modifiedTime,trashed";

const fileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), mimeType: z.string().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
  md5Checksum: z.string().regex(/^[a-f0-9]{32}$/).optional(), size: z.string().regex(/^\d+$/).optional(),
  createdTime: z.iso.datetime({ offset: true }), modifiedTime: z.iso.datetime({ offset: true }), trashed: z.boolean(),
});
const pageSchema = z.object({ files: z.array(fileSchema), nextPageToken: z.string().min(1).optional(), incompleteSearch: z.boolean().optional() });

export type DriveFile = z.infer<typeof fileSchema>;
export interface DriveClient {
  listRoots(): Promise<DriveFile[]>;
  findOrCreateRoot(): Promise<DriveFile>;
  listChildren(rootId: string): Promise<DriveFile[]>;
  createFile(rootId: string, name: string, appProperties: Record<string, string>, bytes: Uint8Array): Promise<DriveFile>;
  updateMedia(id: string, bytes: Uint8Array): Promise<DriveFile>;
  downloadFile(id: string, size?: string): Promise<Buffer>;
}

export class DriveClientError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Drive request failed (HTTP ${status})`);
    this.name = "DriveClientError";
    this.status = status;
  }
}

export class DriveIncompleteSearchError extends Error {
  constructor() {
    super("Drive search is incomplete");
    this.name = "DriveIncompleteSearchError";
  }
}

type Options = { getAccessToken: () => Promise<string>; fetch?: typeof fetch };
const quoted = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

function transferTimeout(size: number | string): number {
  const ms = 30_000n + (BigInt(size) + 65_535n) / 65_536n * 1_000n;
  return Number(ms > 2_147_483_647n ? 2_147_483_647n : ms);
}

export function createDriveClient(options: Options): DriveClient {
  const getAccessToken = options.getAccessToken;
  const fetch = options.fetch ?? globalThis.fetch;

  async function request(url: URL, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
    try {
      const token = await getAccessToken();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new DriveClientError(response.status);
      return response;
    } catch (error) {
      if (error instanceof DriveClientError) throw error;
      throw new DriveClientError(0);
    }
  }

  async function metadata(url: URL, init?: RequestInit, timeout?: number): Promise<DriveFile> {
    url.searchParams.set("fields", FILE_FIELDS);
    const response = await request(url, init, timeout);
    try {
      return fileSchema.parse(await response.json());
    } catch (error) {
      throw new DriveClientError(error instanceof SyntaxError || error instanceof z.ZodError ? response.status : 0);
    }
  }

  async function list(q: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = new URL(FILES_URL);
      url.searchParams.set("q", q);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("fields", `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await request(url);
      let page: z.infer<typeof pageSchema>;
      try {
        page = pageSchema.parse(await response.json());
      } catch (error) {
        throw new DriveClientError(error instanceof SyntaxError || error instanceof z.ZodError ? response.status : 0);
      }
      if (page.incompleteSearch) throw new DriveIncompleteSearchError();
      if (page.nextPageToken && seen.has(page.nextPageToken)) throw new DriveClientError(response.status);
      files.push(...page.files);
      pageToken = page.nextPageToken;
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return files;
  }

  async function listRoots(): Promise<DriveFile[]> {
    const roots = await list(`trashed = false and mimeType = '${FOLDER_TYPE}' and appProperties has { key='winkRoot' and value='1' }`);
    return roots.sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id));
  }

  return {
    listRoots,
    async findOrCreateRoot() {
      const roots = await listRoots();
      if (roots[0]) return roots[0];
      return metadata(new URL(FILES_URL), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Wink sync (managed by Wink)", mimeType: FOLDER_TYPE, appProperties: { winkRoot: "1" } }),
      });
    },
    listChildren(rootId) {
      return list(`trashed = false and '${quoted(rootId)}' in parents`);
    },
    createFile(rootId, name, appProperties, bytes) {
      const boundary = `wink-${randomUUID()}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify({ name, parents: [rootId], appProperties }),
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        new Uint8Array(bytes), `\r\n--${boundary}--\r\n`,
      ]);
      const url = new URL(UPLOAD_URL);
      url.searchParams.set("uploadType", "multipart");
      return metadata(url, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body }, transferTimeout(body.size));
    },
    updateMedia(id, bytes) {
      const url = new URL(`${UPLOAD_URL}/${encodeURIComponent(id)}`);
      url.searchParams.set("uploadType", "media");
      return metadata(url, { method: "PATCH", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) }, transferTimeout(bytes.byteLength));
    },
    async downloadFile(id, size = "0") {
      const url = new URL(`${FILES_URL}/${encodeURIComponent(id)}`);
      url.searchParams.set("alt", "media");
      const response = await request(url, undefined, transferTimeout(size));
      try {
        return Buffer.from(await response.arrayBuffer());
      } catch {
        throw new DriveClientError(0);
      }
    },
  };
}
