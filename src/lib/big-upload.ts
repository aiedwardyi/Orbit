// Resumable upload of one big file to the PC, in chunks that each finish
// well inside the relay's request timeout. The server's offset is the truth:
// after any error the client asks for it and carries on from there.
import { z } from "zod";

import { UPLOAD_MAX_BYTES } from "./composer-attachments.js";
import { holdReload } from "./reload-hold.js";

export const UPLOAD_CHUNK_BYTES = 8 * 1024 ** 2;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000];
const MAX_FAILURES = 10;

export type UploadPhase = "uploading" | "resuming";
export type UploadDone = { path: string; name: string; size: number; type: string };
export type UploadErrorKey =
  | "composer.uploadTooBig"
  | "composer.uploadDiskFull"
  | "composer.uploadBusy"
  | "composer.uploadFailed";

/** A failure retrying will not fix by itself. `key` is what the user reads. */
export class UploadError extends Error {
  constructor(
    readonly key: UploadErrorKey,
    readonly coded = true,
  ) {
    super(key);
  }
}

export function uploadErrorKey(code: string | undefined): UploadErrorKey {
  if (code === "too_big") return "composer.uploadTooBig";
  if (code === "disk_full") return "composer.uploadDiskFull";
  if (code === "busy") return "composer.uploadBusy";
  return "composer.uploadFailed";
}

type UploadFile = Pick<File, "name" | "size" | "type" | "lastModified" | "slice">;

export type UploadOptions = {
  onProgress?: (sent: number) => void;
  onPhase?: (phase: UploadPhase) => void;
  onId?: (id: string) => void;
  signal?: AbortSignal;
  /** An earlier session for this file: continue it instead of creating one. */
  uploadId?: string;
};

class Retry extends Error {}

const FATAL_STATUS = new Set([400, 404, 413, 429, 507]);

const Failure = z.object({ code: z.string().optional() }).catch({});
const Created = z.object({ id: z.string(), offset: z.number(), chunkBytes: z.number().optional() });
const Progress = z.object({
  offset: z.number(),
  done: z.boolean().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  size: z.number().optional(),
  type: z.string().optional(),
});
type Progress = z.infer<typeof Progress>;

async function fail(response: Response): Promise<never> {
  const body = Failure.parse(await response.json().catch(() => ({})));
  if (FATAL_STATUS.has(response.status)) throw new UploadError(uploadErrorKey(body.code));
  throw new Retry(String(response.status));
}

function done(body: Progress, file: UploadFile): UploadDone {
  return { path: body.path ?? "", name: body.name ?? file.name, size: body.size ?? file.size, type: body.type ?? file.type };
}

/** Keeps the screen on while bytes move; the lock drops whenever the page hides. */
function screenLock() {
  let lock: WakeLockSentinel | null = null;
  let asking = false;
  let off = false;
  const take = () => {
    if (off || asking || (lock && !lock.released)) return;
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    asking = true;
    navigator.wakeLock.request("screen").then(
      (next) => {
        asking = false;
        if (off) {
          void next.release().catch(() => {});
          return;
        }
        if (lock && lock !== next) void lock.release().catch(() => {});
        lock = next;
        next.addEventListener("release", () => {
          if (lock === next) lock = null;
        });
      },
      () => (asking = false),
    );
  };
  take();
  return {
    take,
    release: () => {
      off = true;
      void lock?.release().catch(() => {});
    },
  };
}

export function startUpload(file: UploadFile, options: UploadOptions = {}): Promise<UploadDone> {
  return holdReload(run(file, options));
}

export function resumeUpload(id: string, file: UploadFile, options: UploadOptions = {}): Promise<UploadDone> {
  return startUpload(file, { ...options, uploadId: id });
}

export async function cancelUpload(id: string): Promise<void> {
  await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

async function run(file: UploadFile, options: UploadOptions): Promise<UploadDone> {
  const { onProgress, onPhase, onId, signal } = options;
  if (file.size > UPLOAD_MAX_BYTES) throw new UploadError("composer.uploadTooBig");
  let id = options.uploadId ?? "";
  let offset = 0;
  let chunkBytes = UPLOAD_CHUNK_BYTES;
  let failures = 0;
  let resync = Boolean(id);
  // a session from before a reload may be gone; only then does it start over
  let saved = Boolean(id);
  const lock = screenLock();
  // a wake from hiding or a network change skips the back-off and the stale chunk
  let inner = new AbortController();
  let nudged = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    if (document.visibilityState === "hidden") return;
    lock.take();
    nudged = true;
    inner.abort();
    wake?.();
  };
  const onAbort = () => {
    inner.abort();
    wake?.();
  };
  document.addEventListener("visibilitychange", nudge);
  window.addEventListener("online", nudge);
  signal?.addEventListener("abort", onAbort);
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => (wake = null));
  const aborted = () => {
    if (id) void cancelUpload(id);
    return new DOMException("upload cancelled", "AbortError");
  };
  try {
    for (;;) {
      if (signal?.aborted) throw aborted();
      if (inner.signal.aborted) inner = new AbortController();
      nudged = false;
      try {
        if (!id) {
          const response = await fetch("/api/uploads", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }),
            signal: inner.signal,
          });
          if (!response.ok) await fail(response);
          const created = Created.parse(await response.json());
          id = created.id;
          offset = created.offset;
          if (created.chunkBytes) chunkBytes = created.chunkBytes;
          onId?.(id);
          onProgress?.(offset);
          if (signal?.aborted) throw aborted();
        } else if (resync) {
          const response = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { signal: inner.signal });
          if (saved && (response.status === 404 || response.status === 410)) {
            id = "";
            saved = resync = false;
            continue;
          }
          saved = false;
          if (!response.ok) await fail(response);
          const status = Progress.parse(await response.json());
          if (status.done) return done(status, file);
          offset = status.offset;
          onProgress?.(offset);
          resync = false;
        }
        const response = await fetch(`/api/uploads/${encodeURIComponent(id)}/chunk?offset=${offset}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file.slice(offset, Math.min(file.size, offset + chunkBytes)),
          signal: inner.signal,
        });
        if (!response.ok) await fail(response);
        const body = Progress.parse(await response.json());
        if (failures) onPhase?.("uploading");
        failures = 0;
        offset = body.offset;
        onProgress?.(offset);
        if (body.done) return done(body, file);
      } catch (err) {
        if (signal?.aborted) throw aborted();
        if (err instanceof UploadError) throw err;
        resync = Boolean(id);
        if (nudged) continue;
        failures += 1;
        if (failures >= MAX_FAILURES) throw new UploadError("composer.uploadFailed", false);
        onPhase?.("resuming");
        await pause(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!);
      }
    }
  } finally {
    lock.release();
    document.removeEventListener("visibilitychange", nudge);
    window.removeEventListener("online", nudge);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type UploadJob = {
  file: UploadFile;
  uploadId?: string;
  sent: number;
  phase: "queued" | UploadPhase | "failed" | "done";
  /** Only for a failure the user has to act on; plain retries exhausted leave it unset. */
  error?: UploadErrorKey;
  result?: UploadDone;
  controller: AbortController;
  /** Stores the finished chip in its draft before the reload hold lets go. */
  save?: (result: UploadDone, uploadId?: string) => void;
};

// Module-level so an upload keeps going while its composer is unmounted;
// keyed by chip id. One upload runs at a time.
let jobs: ReadonlyMap<string, UploadJob> = new Map();
let running: string | null = null;
const listeners = new Set<() => void>();

function setJob(id: string, patch: Partial<UploadJob> | null) {
  const next = new Map(jobs);
  const job = next.get(id);
  if (patch === null) next.delete(id);
  else if (job) next.set(id, { ...job, ...patch });
  else return;
  jobs = next;
  listeners.forEach((listener) => listener());
}

export function uploadJobs(): ReadonlyMap<string, UploadJob> {
  return jobs;
}

export function onUploadJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pump() {
  if (running) return;
  const [id, job] = [...jobs].find(([, candidate]) => candidate.phase === "queued") ?? [];
  if (!id || !job) return;
  running = id;
  setJob(id, { phase: "uploading" });
  let uploadId = job.uploadId;
  const upload = startUpload(job.file, {
    uploadId,
    signal: job.controller.signal,
    onId: (next) => {
      uploadId = next;
      setJob(id, { uploadId });
    },
    onProgress: (sent) => setJob(id, { sent }),
    onPhase: (phase) => setJob(id, { phase }),
  }).then((result) => {
    if (jobs.has(id)) job.save?.(result, uploadId);
    return result;
  });
  holdReload(upload)
    .then(
      (result) => setJob(id, { phase: "done", result, sent: result.size }),
      (err) => {
        if (job.controller.signal.aborted) return;
        setJob(id, { phase: "failed", error: err instanceof UploadError && err.coded ? err.key : undefined });
      },
    )
    .finally(() => {
      running = null;
      pump();
    });
}

export function queueUpload(id: string, file: UploadFile, uploadId?: string, save?: UploadJob["save"]): void {
  const next = new Map(jobs);
  next.set(id, { file, uploadId, sent: 0, phase: "queued", controller: new AbortController(), save });
  jobs = next;
  listeners.forEach((listener) => listener());
  pump();
}

export function retryUpload(id: string): void {
  const job = jobs.get(id);
  if (job?.phase !== "failed") return;
  setJob(id, { phase: "queued", error: undefined, controller: new AbortController() });
  pump();
}

/** Stops and forgets an upload; whatever reached the PC is deleted there. */
export function dropUpload(id: string, uploadId?: string): void {
  const job = jobs.get(id);
  setJob(id, null);
  if (job && running === id) {
    job.controller.abort();
    return;
  }
  const target = job?.uploadId ?? uploadId;
  if (target) void cancelUpload(target);
}

/** Forgets a finished upload once its chip holds the result. */
export function forgetUpload(id: string): void {
  setJob(id, null);
}
