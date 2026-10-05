// A phone can view a file a bot linked in a chat. The path must be that link,
// and after realpath it must sit inside that bot's output roots.
import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, relative } from "node:path";
import { pipeline } from "node:stream";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { apiRequestAuthorized } from "./remote-access.ts";

const MEDIA = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  pdf: "application/pdf",
} as const;

type MediaExt = keyof typeof MEDIA;

function isMediaExt(value: string): value is MediaExt {
  return Object.hasOwn(MEDIA, value);
}

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export interface LinkedMessage {
  id: string;
  text?: string;
  fromBotId?: string;
}

export interface ServeLinkedFileOptions {
  bearerOk: boolean;
  remoteKey: string | undefined;
  threadId: string;
  messages: readonly LinkedMessage[];
  deviceId: string;
  writerDeviceId(messageId: string): string | null;
  rootsFor(message: LinkedMessage): readonly string[];
}

function sendJson(res: ServerResponse, status: number, body: { error: string; deviceId?: string }): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "private, no-store",
  });
  res.end(data);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mediaType(filePath: string): (typeof MEDIA)[MediaExt] | null {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return isMediaExt(ext) ? MEDIA[ext] : null;
}

function absolutePath(value: string): string | null {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function localFilePath(href: string): string | null {
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(decodeHref(href));
}

function resolveRelativePath(href: string, base: string): string | null {
  const root = absolutePath(base);
  if (!root || /^[#?]/.test(href)) return null;
  let rel = href.replace(/[#?].*$/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch { /* keep the raw target */ }
  const win = WINDOWS_PATH.test(root);
  const drive = win ? `${root.slice(0, 2)}\\` : "/";
  const parts = root.slice(win ? 3 : 1).split(/[\\/]+/).filter(Boolean);
  const depth = parts.length;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "..") {
      if (parts.length === depth) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return drive + parts.join(win ? "\\" : "/");
}

function linkUrls(text: string): string[] {
  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch {
    return [];
  }
  const defs = new Map<string, string>();
  const urls: string[] = [];
  const refs: string[] = [];
  const walk = (node: typeof tree | (typeof tree)["children"][number]) => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "definition") defs.set(node.identifier, node.url);
    else if (node.type === "link" || node.type === "image") urls.push(node.url);
    else if (node.type === "linkReference" || node.type === "imageReference") refs.push(node.identifier);
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  for (const id of refs) {
    const url = defs.get(id);
    if (url) urls.push(url);
  }
  return urls;
}

function linkTargets(text: string, roots: readonly string[]): string[] {
  const targets: string[] = [];
  for (const dest of linkUrls(text)) {
    const local = localFilePath(dest);
    if (local) {
      targets.push(local);
      continue;
    }
    if (SCHEME.test(dest)) continue;
    for (const root of roots) {
      const resolved = resolveRelativePath(dest, root);
      if (resolved) targets.push(resolved);
    }
  }
  return targets;
}

function nameForms(filePath: string): string[] {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  return name ? [...new Set([name, encodeURI(name), encodeURIComponent(name)])] : [];
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7E]/g, "_").replaceAll("\\", "_").replaceAll("\"", "") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function samePath(a: string, b: string): boolean {
  const slash = (value: string) => value.replaceAll("\\", "/");
  const left = slash(a);
  const right = slash(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function insideRoot(real: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (/^[\\/]{2}/.test(root)) return false;
    try {
      const from = relative(realpathSync(root), real);
      return from !== "" && !from.startsWith("..") && !isAbsolute(from);
    } catch {
      return false;
    }
  });
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | "all" | "bad" {
  if (!header) return "all";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "bad";
  let start: number;
  let end: number;
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (match[1] !== "") {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  } else return "bad";
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return "bad";
  return { start, end: Math.min(end, size - 1) };
}

function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, size: number, mime: string): void {
  const range = byteRange(header(req.headers.range), size);
  if (range === "bad") {
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    res.end();
    return;
  }
  const start = range === "all" ? 0 : range.start;
  const end = range === "all" ? size - 1 : range.end;
  const status = range === "all" ? 200 : 206;
  const shared = {
    "content-type": mime,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    "cache-control": "private",
    "x-content-type-options": "nosniff",
    "content-disposition": contentDisposition(basename(filePath)),
  };
  res.writeHead(status, status === 206 ? { ...shared, "content-range": `bytes ${start}-${end}/${size}` } : shared);
  // An unread 'error' from the file stream is uncaught and kills the utility process.
  pipeline(createReadStream(filePath, { start, end }), res, (error) => {
    if (error) res.destroy();
  });
}

export function serveLinkedFile(req: IncomingMessage, res: ServerResponse, options: ServeLinkedFileOptions): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!apiRequestAuthorized(options.bearerOk, header(req.headers.cookie), options.remoteKey, url.pathname)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const requested = url.searchParams.get("path") ?? "";
  // UNC and device paths can block realpath on a network share.
  if (!requested || /^[\\/]{2}/.test(requested) || requested.startsWith("\\\\?\\") || requested.startsWith("\\\\.\\")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const forms = nameForms(requested);
  const hits: { id: string; roots: readonly string[] }[] = [];
  for (const message of options.messages) {
    const text = message.text ?? "";
    // Parsing every message of a long chat took seconds; only a message naming the file can link it.
    if (!forms.some((form) => text.includes(form))) continue;
    const roots = options.rootsFor(message);
    if (!linkTargets(text, roots).some((target) => samePath(target, requested))) continue;
    hits.push({ id: message.id, roots });
  }
  if (!hits.length) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  let real: string | null = null;
  try {
    real = realpathSync(requested);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }
  if (!real) {
    const mime = mediaType(requested);
    const writer = mime
      ? hits.map((hit) => options.writerDeviceId(hit.id)).find((id) => id && id !== options.deviceId && DEVICE_ID.test(id))
      : undefined;
    sendJson(res, 404, writer ? { error: "not found", deviceId: writer } : { error: "not found" });
    return;
  }
  let size = 0;
  try {
    const stat = statSync(real);
    if (!stat.isFile() || stat.size <= 0) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    size = stat.size;
  } catch {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const mime = mediaType(real);
  if (!mime || !mediaType(requested) || !insideRoot(real, hits.flatMap((hit) => hit.roots))) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  sendFile(req, res, real, size, mime);
}
