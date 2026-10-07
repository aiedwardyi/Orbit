// Operational log. Only allowlisted keys with bounded, shape-checked values
// reach the sink, so payload bytes, keys, tickets, invites, cookies and auth
// frames cannot be logged by accident (design section 9).

import { LABEL_RE } from "../../shared/relay-protocol.ts";

export type LogSink = (line: string) => void;
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Partial<Record<LogKey, LogValue>>;

export interface Logger {
  log(event: string, fields?: LogFields): void;
}

const EVENT_RE = /^[a-z][a-z0-9.-]{0,47}$/;
const WORD_RE = /^[a-z0-9][a-z0-9._/-]{0,31}$/;
const PEER_RE = /^[0-9a-f.:]{1,40}\/(24|48)$/;

const CHECKS = {
  label: (v: string) => LABEL_RE.test(v),
  peer: (v: string) => PEER_RE.test(v),
  reason: (v: string) => WORD_RE.test(v),
  code: (v: string) => WORD_RE.test(v),
  route: (v: string) => WORD_RE.test(v),
  alpn: (v: string) => WORD_RE.test(v),
  bytesIn: null,
  bytesOut: null,
  durationMs: null,
  count: null,
  limit: null,
  notAfter: null,
} satisfies Record<string, ((v: string) => boolean) | null>;

export type LogKey = keyof typeof CHECKS;

const REDACTED = "[redacted]";

/** Maps fields onto the allowlist. Unknown keys are dropped, bad values redacted. */
export function sanitize(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(CHECKS, key) || value === undefined) continue;
    const check = CHECKS[key as LogKey];
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? Math.round(value) : null;
    else out[key] = check && check(value) ? value : REDACTED;
  }
  return out;
}

export function createLogger(sink: LogSink, now: () => number = Date.now): Logger {
  return {
    log(event, fields = {}) {
      const name = EVENT_RE.test(event) ? event : "invalid-event";
      try {
        sink(JSON.stringify({ t: new Date(now()).toISOString(), event: name, ...sanitize(fields) }));
      } catch {
        // A broken sink must never take the relay down.
      }
    },
  };
}

export const stdoutLogger = (): Logger => createLogger((line) => process.stdout.write(`${line}\n`));
export const silentLogger: Logger = { log() {} };
