// Image attachments: pasted/dropped images become files under
// ~/.orbit/attachments so every CLI engine can open them by path.
// the app never ships image bytes through the prompt itself.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { DATA_DIR } from "./config.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** The spec's ceiling: a screenshot bigger than this is rejected before it
 * is ever buffered, matching the composer's existing size discipline. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename. */
const IMAGE_MIMES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return IMAGE_MIMES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function ensureAttachmentsDir(): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

/** Persist one image and return its path. The UUID filename means the name
 * is never attacker-controlled and never collides; the extension preserves
 * the format the sender claimed. */
export function saveImage(bytes: Buffer, mime: string): SavedAttachment {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported image type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty image"), { status: 400 });
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`), { status: 413 });
  }
  ensureAttachmentsDir();
  const name = `${randomUUID()}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
}

/** Format from magic bytes, never from the name or a claimed mime. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Copy a bot's local image into the store; the original path is never served.
 * UNC and device paths are refused before any fs call: resolving one can block the event loop on a network share. */
export function importLocalImage(path: string, roots: readonly string[]): SavedAttachment & { name: string } {
  const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });
  const outside = "image must be inside your project or workspace folder; save it there first";
  if (/^[\\/]{2}/.test(path)) throw fail(403, outside);
  if (!isAbsolute(path)) throw fail(400, "path must be absolute");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw fail(404, "file not found");
  }
  if (/^[\\/]{2}/.test(real)) throw fail(403, outside);
  const allowed = roots.some((root) => {
    if (/^[\\/]{2}/.test(root)) return false;
    try {
      const fromRoot = relative(realpathSync(root), real);
      return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
    } catch {
      return false;
    }
  });
  if (!allowed) throw fail(403, outside);
  let size: number;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) throw fail(400, "not a regular file");
    size = stat.size;
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw fail(404, "file not found");
  }
  if (size === 0) throw fail(400, "empty image");
  if (size > IMAGE_MAX_BYTES) throw fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
  const bytes = readFileSync(real);
  const mime = sniffImageMime(bytes);
  if (!mime) throw fail(400, "not a PNG, JPEG, GIF, or WebP image");
  const saved = saveImage(bytes, mime);
  return { ...saved, name: basename(saved.path) };
}

/** Existence check with the same name discipline as readAttachment, without
 * reading up to 10MB of pixels just to learn the file is there. */
export function attachmentExists(name: string): boolean {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return false;
  try {
    return statSync(join(ATTACHMENTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir. */
export function readAttachment(name: string): { bytes: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) return null;
  const path = join(ATTACHMENTS_DIR, name);
  if (extname(path) === ".jpeg") return null; // saved as .jpg; .jpeg is not a name we write
  try {
    return { bytes: readFileSync(path), mime: mimeForExt(extname(path)) };
  } catch {
    return null;
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
