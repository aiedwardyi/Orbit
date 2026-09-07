// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { endsContentStream, redactSecrets, redactSecretsInText, StreamSecretMasker } from "../redact.ts";

type NativeEntry = { dir: "in" | "out"; source: string; msg: unknown };
type NativeStream = { masker: StreamSecretMasker; dir: NativeEntry["dir"]; source: string; path: string[] };
const nativeMaskers = new Map<string, Map<string, NativeStream>>();
const TEXT_FIELDS = /^(text|delta|thinking|reasoning|reasoning_content|content|arguments|partial_json|output|input|message|prompt|completion)$/;

// Native payloads have no shared schema; the redactor bounds and copies this walk.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
function maskNative(threadId: string, entry: NativeEntry, value: unknown, safe: unknown, path: string[] = [], content = false): unknown {
  if (typeof value === "string") {
    // Name-based credential masks must not reappear later as context-free tails.
    if ((path.length && !content) || safe !== redactSecretsInText(value)) return safe;
    let streams = nativeMaskers.get(threadId);
    if (!streams) nativeMaskers.set(threadId, streams = new Map());
    const key = JSON.stringify([entry.dir, entry.source, path]);
    let stream = streams.get(key);
    if (!stream) {
      stream = { masker: new StreamSecretMasker(), dir: entry.dir, source: entry.source, path };
      streams.set(key, stream);
    }
    return stream.masker.push(value);
  }
  if (!value || typeof value !== "object" || !safe || typeof safe !== "object") return safe;
  if (Array.isArray(value)) {
    // SAFETY: redactSecrets preserves arrays until it replaces a subtree with a string.
    const safeItems = safe as unknown[];
    return value.map((item, index) => maskNative(threadId, entry, item, safeItems[index], [...path, String(index)], content));
  }
  // SAFETY: both values are non-null objects, and arrays returned above.
  const record = value as Record<string, unknown>;
  // Protocol discriminators separate thought and message chunks at the same path.
  const kind = JSON.stringify(["type", "sessionUpdate", "method", "event", "streamKind"].map((key) =>
    typeof record[key] === "string" ? record[key] : "",
  ));
  // SAFETY: the redacted object preserves this record's keys.
  const safeRecord = safe as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    maskNative(threadId, entry, item, safeRecord[key], [...path, `${kind}:${key}`], content || TEXT_FIELDS.test(key)),
  ]));
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

export function finishNative(event: { threadId: string; type: string }) {
  if (!endsContentStream(event.type)) return;
  const streams = nativeMaskers.get(event.threadId);
  nativeMaskers.delete(event.threadId);
  if (!streams) return;
  for (const { masker, dir, source, path } of streams.values()) {
    const text = masker.flush();
    if (text) writeNative(event.threadId, { dir, source, msg: { nativeTextTail: { path: redactSecrets(path), text } } });
  }
}

export function appendNative(threadId: string, entry: NativeEntry) {
  try {
    const safe = redactSecrets(entry.msg);
    // Outbound protocol requests are complete messages, not provider deltas.
    const msg = entry.dir === "out" ? safe : maskNative(threadId, entry, entry.msg, safe);
    writeNative(threadId, { ...entry, msg });
  } catch {
    /* never let logging break a run */
  }
}

function writeNative(threadId: string, entry: NativeEntry) {
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. These files are ordinary
    // 0644 files people paste into bug reports, so values are masked while
    // the shape stays intact.
    appendFileSync(
      join(NATIVE_DIR, `${threadId}.ndjson`),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* never let logging break a run */
  }
}
