import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  CREDENTIAL_BROKER,
  CREDENTIAL_TARGETS,
  isBrokeredCredentialId,
  isCredentialTargetId,
  type BrokeredCredentialId,
} from "../shared/credential-request.ts";
import { writeFileAtomic } from "./atomic.ts";
import { generatedImagesDir } from "./generate-image.ts";

export const CALL_API_TIMEOUT_MS = 60_000;
export const CALL_API_TEXT_CHARS = 20_000;
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const KEY_USES_FILE = "key-uses.json";
const BINARY_TYPE = /^(image\/|audio\/|application\/pdf$|application\/octet-stream$)/;
const EXTENSIONS: Record<string, string> = { "audio/mpeg": "mp3", "image/jpeg": "jpg", "application/octet-stream": "bin" };

export const callApiRequestSchema = z.object({
  credentialId: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(4000),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

export type CallApiRequest = z.infer<typeof callApiRequestSchema>;
export type CallApiResult = { status: number; text: string } | { status: number; path: string; contentType: string };
export type KeyUses = Record<string, { botId: string; at: string }>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export const missingKeyMessage = (id: BrokeredCredentialId) =>
  `No ${CREDENTIAL_TARGETS[id].label} saved. Call request_credential with ${id}, end the turn, then retry call_api.`;

export function redactKey(text: string, key: string): string {
  return (key ? text.split(key).join("[key]") : text).replace(/\b(?:sk|xai)-[\w*.-]{8,}/g, "[key]");
}

async function boundedBytes(response: Response): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw fail(502, "response exceeded the 15 MB limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail(502, "response exceeded the 15 MB limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

/** Sends one request with the saved key injected; the key never leaves this process in a result. */
export async function callApi(
  request: CallApiRequest,
  keyFor: (id: BrokeredCredentialId) => string,
  roots: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CALL_API_TIMEOUT_MS,
): Promise<CallApiResult> {
  const id = request.credentialId;
  if (!isBrokeredCredentialId(id)) {
    throw fail(400, isCredentialTargetId(id)
      ? `${CREDENTIAL_TARGETS[id].label} is not available through call_api.`
      : "unsupported credential id");
  }
  const rule = CREDENTIAL_BROKER[id];
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw fail(400, "url must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw fail(400, "url must be https");
  if (!(rule.hosts as readonly string[]).includes(url.host)) {
    throw fail(403, `${id} may only call ${rule.hosts.join(", ")}`);
  }
  const headers = new Headers(request.headers ?? {});
  if (headers.has(rule.header)) throw fail(400, `do not set ${rule.header}; Orbit adds the key`);
  const key = keyFor(id).trim();
  if (!key) throw fail(409, missingKeyMessage(id));
  headers.set(rule.header, `${rule.prefix}${key}`);
  let body: string | undefined;
  if (typeof request.body === "string") body = request.body;
  else if (request.body !== undefined && request.body !== null) {
    body = JSON.stringify(request.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let bytes: Buffer;
  try {
    response = await fetchImpl(url, { method: request.method, headers, body, redirect: "manual", signal });
    bytes = await boundedBytes(response);
  } catch (error) {
    if (signal.aborted) throw fail(504, `request timed out after ${timeoutMs / 1000}s`);
    throw fail((error as { status?: number }).status ?? 502, redactKey(String((error as Error).message), key).slice(0, 300));
  }
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, text: `HTTP ${response.status}: redirect not followed` };
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (response.ok && BINARY_TYPE.test(contentType)) {
    const ext = EXTENSIONS[contentType] ?? (contentType.split("/")[1]!.replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin");
    const path = join(generatedImagesDir(roots, "api-files"), `response-${randomBytes(4).toString("hex")}.${ext}`);
    writeFileSync(path, bytes, { flag: "wx" });
    return { status: response.status, path, contentType };
  }
  const full = redactKey(bytes.toString("utf8"), key);
  const text = full.length > CALL_API_TEXT_CHARS ? `${full.slice(0, CALL_API_TEXT_CHARS)}\n[truncated]` : full;
  return { status: response.status, text: `HTTP ${response.status}\n${text}` };
}

export function loadKeyUses(dataDir: string): KeyUses {
  try {
    const parsed = z.record(z.string(), z.object({ botId: z.string(), at: z.string() }))
      .safeParse(JSON.parse(readFileSync(join(dataDir, KEY_USES_FILE), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Best effort: a failed write never fails the call that used the key. */
export function recordKeyUse(dataDir: string, id: string, botId: string, at = new Date()): void {
  const uses = { ...loadKeyUses(dataDir), [id]: { botId, at: at.toISOString() } };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(join(dataDir, KEY_USES_FILE), JSON.stringify(uses, null, 2));
  } catch {
    // Last-used is display only.
  }
}
