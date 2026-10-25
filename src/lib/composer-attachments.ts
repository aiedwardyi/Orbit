// What is attached to the next message: text too long for the input or a
// file dropped onto the window. Chips fold back into a normal prompt on
// send, so every driver receives the same message shape.
import { z } from "zod";

import { holdReload } from "./reload-hold.js";

export type PasteAttachment = {
  kind: "paste";
  id: string;
  text: string;
  size: number;
  lines: number;
};

export type FileAttachment = {
  kind: "file";
  id: string;
  path: string;
  name: string;
  size: number;
  type?: string;
  /** Set when the file was uploaded; it counts toward the per-message upload limit. */
  uploadId?: string;
};

/** A file still on its way to the PC. Send waits until it becomes a file chip. */
export type UploadAttachment = {
  kind: "upload";
  id: string;
  uploadId?: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sent: number;
  state: "uploading" | "resuming" | "failed" | "repick";
};

export type ImageAttachment = {
  kind: "image";
  id: string;
  path: string;
  name: string;
  size: number;
  mime: string;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment | UploadAttachment;

export type ImageSupport = "supported" | "unsupported" | "unknown";

export type ComposerThreadNotice = { threadId: string; text: string };

/** Image-refusal copy for the composer that produced it. */
export function imageSupportNotice(
  support: ImageSupport,
  copy: { unsupported: string; loading: string },
): string | null {
  if (support === "supported") return null;
  return support === "unknown" ? copy.loading : copy.unsupported;
}

/** A composer notice follows its thread, never the app shell. */
export function visibleComposerNotice(
  notice: ComposerThreadNotice | null,
  threadId: string,
): string | null {
  if (!notice || notice.threadId !== threadId) return null;
  return notice.text;
}

export function imageSupportForTargets(
  instances: readonly { instanceId: string; capabilities?: { images?: boolean } }[],
  targets: readonly { modelSelection: { instanceId: string } }[],
): ImageSupport {
  if (!targets.length) return "unsupported";
  let unknown = false;
  for (const target of targets) {
    const instance = instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId);
    if (!instance) {
      unknown = true;
      continue;
    }
    if (instance.capabilities?.images !== true) return "unsupported";
  }
  return unknown ? "unknown" : "supported";
}

export function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  if (typeof attachment.id !== "string" || !validSize(attachment.size)) return false;
  if (attachment.kind === "paste") {
    return (
      typeof attachment.text === "string" &&
      typeof attachment.lines === "number" &&
      Number.isInteger(attachment.lines) &&
      attachment.lines >= 1
    );
  }
  if (attachment.kind === "file") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string"
    );
  }
  if (attachment.kind === "image") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string" &&
      typeof attachment.mime === "string" &&
      attachment.mime.startsWith("image/")
    );
  }
  if (attachment.kind === "upload") return StoredUpload.safeParse(attachment).success;
  return false;
}

/** A File cannot be read again after a reload, so a stored upload waits for a re-pick. */
export function restoredAttachment(attachment: Attachment): Attachment {
  return attachment.kind === "upload" ? { ...attachment, state: "repick" } : attachment;
}

const StoredUpload = z.object({
  uploadId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  lastModified: z.number(),
  sent: z.number().nonnegative(),
});

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Past this, a paste stops reading as typing and becomes an attachment.
 * Long-but-narrow (a stack trace, a log) counts by line, not just chars. */
export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || countLines(text) >= PASTE_LINES;
}

export function countLines(text: string): number {
  return text.split("\n").length;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;
}

export function fileAttachment(name: string, path: string, size: number, type = ""): FileAttachment {
  const attachment: FileAttachment = { kind: "file", id: newId(), path, name, size };
  if (type) attachment.type = type;
  return attachment;
}

export function uploadAttachment(file: Pick<File, "name" | "size" | "type" | "lastModified">): UploadAttachment {
  return {
    kind: "upload",
    id: newId(),
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    sent: 0,
    state: "uploading",
  };
}

/** Matches the server's IMAGE_MAX_BYTES — checked client-side so an
 * oversized paste is refused before the upload starts, not mid-stream. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 10 * 1024 ** 3;

const DOCUMENT_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|json)$/i;

export function isImageFile(file: { type: string; size: number }): boolean {
  return (
    file.type.startsWith("image/") &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type.split(";")[0]!.trim().toLowerCase())
  );
}

async function uploadAttachmentFile(
  file: Pick<File, "name" | "type" | "arrayBuffer">,
  document = false,
): Promise<{ path: string; name?: string; mime: string; bytes: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const headers = new Headers({ "content-type": file.type || "application/octet-stream" });
  if (document) headers.set("x-attachment-name", encodeURIComponent(file.name));
  const response = await holdReload(
    fetch("/api/attachments", {
      method: "POST",
      headers,
      body: bytes,
    }),
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw Object.assign(new Error(detail.error ?? "upload failed"), { status: response.status });
  }
  return z.object({ path: z.string(), name: z.string().optional(), mime: z.string(), bytes: z.number() }).parse(await response.json());
}

/** Persist a pasted image server-side and return the attachment chip data.
 * When the engine accepts images in the prompt, returns an ImageAttachment.
 * When the engine does not support inline images, returns a FileAttachment
 * so the bot can open the file from disk via its tools. */
export async function pasteImageAttachment(
  file: File,
  allowImages = true,
  uploader: (file: File) => Promise<{ path: string; mime: string; bytes: number }> = uploadAttachmentFile,
): Promise<Attachment | null> {
  if (!isImageFile(file)) return null;
  const saved = await uploader(file);
  const name = file.name || "pasted image";
  if (allowImages) {
    return { kind: "image", id: newId(), path: saved.path, name, size: saved.bytes, mime: saved.mime };
  }
  return { kind: "file", id: newId(), path: saved.path, name, size: saved.bytes };
}

/** Drops 0-byte images. Chromium on Windows pastes a screenshot as an empty
 * image.png while another app holds the clipboard; the desktop app rereads it. */
export async function rereadEmptyImages(
  files: readonly File[],
  readClipboardImage?: () => Promise<Uint8Array<ArrayBuffer> | null>,
): Promise<File[]> {
  const kept = files.filter((file) => file.size > 0);
  if (kept.length === files.length || !readClipboardImage) return kept;
  const png = await readClipboardImage().catch(() => null);
  return png?.length ? [...kept, new File([png], "image.png", { type: "image/png" })] : kept;
}

/** Legacy wrapper for image-only intake. */
export async function imageAttachmentFromFile(file: File): Promise<ImageAttachment | null> {
  const result = await pasteImageAttachment(file, true);
  return result?.kind === "image" ? result : null;
}

export function pasteAttachment(text: string): PasteAttachment {
  const id = newId();
  // measured once, here: a chip re-renders on every keystroke in the
  // composer, and encoding half a megabyte each time would be felt
  return { kind: "paste", id, text, size: byteLength(text), lines: countLines(text) };
}

/** Move a pasted attachment into the editable composer draft without
 * running the text back through the paste threshold. */
export function appendPastedText(text: string, pasted: string): string {
  if (!text) return pasted;
  return `${text}${text.endsWith("\n") ? "" : "\n\n"}${pasted}`;
}

export const INLINE_DROP_LIMIT = 512 * 1024;

export type DroppedFile = Pick<File, "name" | "size" | "type" | "text">;

/** Turn a browser drop into composer attachments. Electron-backed files
 * keep their disk path; small pathless text drops keep their contents.
 * Promise.all preserves the user's drop order even when text reads finish
 * in a different order. */
export async function attachmentsFromDroppedFiles<T extends DroppedFile>(
  files: readonly T[],
  getPath: (file: T) => string,
): Promise<{ attachments: Attachment[]; rejectedNames: string[] }> {
  const results = await Promise.all(
    files.map(async (file) => {
      const path = safeGetPath(file, getPath);
      if (path) return { attachment: fileAttachment(file.name, path, file.size) };
      if (isInlineText(file) && file.size <= INLINE_DROP_LIMIT) {
        try {
          return { attachment: pasteAttachment(await file.text()) };
        } catch {
          // Treat an unreadable browser drag like any other pathless file.
        }
      }
      return { rejectedName: file.name };
    }),
  );

  return {
    attachments: results.flatMap((result) =>
      "attachment" in result && result.attachment ? [result.attachment] : [],
    ),
    rejectedNames: results.flatMap((result) =>
      "rejectedName" in result && result.rejectedName ? [result.rejectedName] : [],
    ),
  };
}

function isInlineText(file: DroppedFile): boolean {
  return file.type.startsWith("text/") || file.type === "application/json";
}

/** A browser or older desktop shell has no disk path to expose. */
function safeGetPath<T>(file: T, getPath: (file: T) => string): string {
  try {
    return getPath(file);
  } catch {
    return "";
  }
}

/** What the paste actually weighs — String#length counts UTF-16 units, so
 * it reads a third under on accented text and half under on CJK. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "12 lines, 3.4 KB" — what the chip says under the preview. */
export function pasteSummary(a: { lines: number; size: number }): string {
  return `${a.lines} lines, ${formatSize(a.size)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The prompt the bot receives: what was typed, then one block per
 * attachment. Tagged blocks rather than fences — pasted code and markdown
 * carry fences of their own, and nesting them loses the boundary. A file
 * needs only its path: every driver here is an agent that can open it. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    if (a.kind === "paste") {
      parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
    } else if (a.kind === "image") {
      parts.push(`<attached-image path="${escapeAttribute(a.path)}" />`);
    } else if (a.kind === "file") {
      const type = a.type ? ` type="${escapeAttribute(a.type)}"` : "";
      parts.push(`<attached-file path="${escapeAttribute(a.path)}" name="${escapeAttribute(a.name)}" size="${a.size}"${type} />`);
    }
  });
  return parts.filter(Boolean).join("\n\n");
}

/** File paths are untrusted prompt content. Keep them inside the quoted
 * attribute even when a filename contains XML characters or line breaks. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#9;", "\t")
    .replaceAll("&#13;", "\r")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
}

export type AttachedFile = { path: string; name: string; size?: number };

const ATTACHED_FILE = /<attached-file\s+path="([^"]*)"((?:\s+[a-z]+="[^"]*")*)\s*\/?>/g;

function attachedFile(rawPath: string, rawAttributes: string): AttachedFile {
  const path = unescapeAttribute(rawPath);
  const attributes = Object.fromEntries(
    [...rawAttributes.matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescapeAttribute(value ?? "")]),
  );
  const file: AttachedFile = { path, name: attributes.name || attachmentBasename(path) };
  const size = Number(attributes.size);
  if (attributes.size && Number.isFinite(size) && size >= 0) file.size = size;
  return file;
}

/** One-line previews: each attached file reads as its name, in place. */
export function attachedFilePreview(text: string, label = (name: string) => name): string {
  return splitAttachedImages(text.replace(ATTACHED_FILE, (_match, path: string, rest: string) => label(attachedFile(path, rest).name)))
    .display;
}

/** Split a stored user message into its display text and the images and
 * files it attached, for transcript rendering. Tags never show in the bubble. */
export function splitAttachedImages(text: string): { display: string; images: string[]; files: AttachedFile[] } {
  const pasted: string[] = [];
  let display = text.replace(
    /<pasted-text(?:\s+index="\d+")?>\n?([\s\S]*?)\n?<\/pasted-text>/g,
    (_match, inner: string) => {
      pasted.push(inner);
      return `\0PASTE${pasted.length - 1}\0`;
    },
  );
  const images: string[] = [];
  display = display.replace(/<attached-image\s+path="([^"]*)"\s*\/?>(?:\s*\n)?/g, (_match, raw: string) => {
    const path = unescapeAttribute(raw);
    if (path) images.push(path);
    return "";
  });
  const files: AttachedFile[] = [];
  display = display.replace(new RegExp(`${ATTACHED_FILE.source}(?:\\s*\\n)?`, "g"), (_match, path: string, rest: string) => {
    files.push(attachedFile(path, rest));
    return "";
  });
  display = display.replace(/\0PASTE(\d+)\0/g, (_match, index: string) => pasted[Number(index)] ?? "");
  return { display: display.trim(), images, files };
}

/** The bare filename a saved attachment path ends in — what the serving
 * route expects. Works for POSIX and Windows separators. */
export function attachmentBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The renderer never loads a transcript-provided URL directly. Only names
 * the attachment server itself can have generated become same-origin image
 * URLs; malformed and executable-image paths render nothing, while a string
 * that looks remote can at most resolve to a local generated filename. */
export function attachmentImageUrl(path: string): string | null {
  const name = attachmentBasename(path);
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return null;
  return `/api/attachments/${encodeURIComponent(name)}`;
}

/** Shared intake for the attach button and file drops on every device.
 * A file with no disk path that the attachment route won't take becomes an
 * upload chip; the caller starts its upload from `uploads`. */
export async function intakeFiles<T extends DroppedFile & Pick<File, "arrayBuffer"> & Partial<Pick<File, "lastModified">>>(
  _files: readonly T[],
  _opts: {
    allowImages: boolean;
    getPath: (file: T) => string;
    uploadImage: (file: T, allowImages: boolean) => Promise<Attachment | null>;
    t: (key: "composer.uploadTooBig" | "composer.uploadFailed", vars?: Record<string, string | number>) => string;
  },
): Promise<{ attachments: Attachment[]; uploads: { id: string; file: T }[]; notice: string | null }> {
  const files = [..._files];
  const { allowImages, getPath, uploadImage, t } = _opts;
  const attachments: Attachment[] = [];
  const uploads: { id: string; file: T }[] = [];
  const tooBig: string[] = [];
  const uploadErrors: string[] = [];
  const bigUpload = (file: T) => {
    if (file.size > UPLOAD_MAX_BYTES) {
      tooBig.push(t("composer.uploadTooBig", { name: file.name }));
      return;
    }
    const chip = uploadAttachment({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified ?? 0 });
    attachments.push(chip);
    uploads.push({ id: chip.id, file });
  };
  // Finish each selected file in sequence so the chips retain the order in
  // which the user chose or dropped them.
  for (const file of files) {
    const path = safeGetPath(file, getPath);
    if (isImageFile(file)) {
      if (path && (!allowImages || file.size > IMAGE_MAX_BYTES)) {
        attachments.push(fileAttachment(file.name, path, file.size, file.type));
      } else if (file.size > IMAGE_MAX_BYTES) {
        bigUpload(file);
      } else {
        // A pathless image (phone, web) has no other way to reach the bot, so
        // it uploads even when the engine cannot read it inline, same as paste.
        try {
          const attachment = await uploadImage(file, allowImages);
          if (attachment) attachments.push(attachment);
        } catch (err) {
          uploadErrors.push(`${file.name}: ${err instanceof Error ? err.message : t("composer.uploadFailed")}`);
        }
      }
      continue;
    }
    if (path) {
      attachments.push(fileAttachment(file.name, path, file.size, file.type));
    } else if (DOCUMENT_EXTENSION.test(file.name) && file.size <= DOCUMENT_MAX_BYTES) {
      try {
        const saved = await uploadAttachmentFile(file, true);
        attachments.push(fileAttachment(saved.name ?? attachmentBasename(file.name), saved.path, saved.bytes, file.type));
      } catch {
        uploadErrors.push(`${file.name}: ${t("composer.uploadFailed")}`);
      }
    } else if (file.type === "text/plain") {
      const result = await attachmentsFromDroppedFiles([file], getPath);
      attachments.push(...result.attachments);
      if (result.rejectedNames.length) bigUpload(file);
    } else {
      bigUpload(file);
    }
  }
  const notices = [...tooBig, ...uploadErrors];
  return { attachments, uploads, notice: notices.length ? notices.join(" ") : null };
}
