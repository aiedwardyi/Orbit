// Certificate Transparency check (design section 11). Once a day, list the
// certificates logged for this PC's host and compare their public keys with
// the keys this PC generated. A verified unknown key is reported; a lookup
// failure or timeout is not evidence of anything. This detects a mis-issued
// certificate after the fact. It cannot stop a relay or DNS operator who
// passes the challenge and intercepts new phone connections.

import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { CT_ALERT_PREFIX } from "../phone-auth.ts";
import type { Cancel, Clock } from "./clock.ts";
import { httpsRequest, type HttpsDeps } from "./https.ts";
import { readKeyHistory, spkiFingerprint } from "./store.ts";

export const CT_FIRST_CHECK_MS = 10 * 60_000;
export const CT_INTERVAL_MS = 24 * 60 * 60_000;
export const CT_TIMEOUT_MS = 20_000;
export const CT_LIST_MAX_BYTES = 2 * 1024 * 1024;
export const CT_CERT_MAX_BYTES = 64 * 1024;
export const CT_MAX_CERTS_PER_RUN = 20;

export interface CtSource {
  /** Log entry ids for certificates naming `host`, newest first is not required. */
  list(host: string): Promise<number[]>;
  /** PEM of one logged certificate or precertificate. */
  fetch(id: number): Promise<string>;
}

const crtShListSchema = z.array(z.object({ id: z.int().positive() })).max(10_000);

function parseJsonText(text: string): z.core.util.JSONType | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function crtShSource(deps: HttpsDeps = {}): CtSource {
  return {
    async list(host) {
      const res = await httpsRequest(
        {
          method: "GET",
          url: `https://crt.sh/?q=${encodeURIComponent(host)}&output=json`,
          timeoutMs: CT_TIMEOUT_MS,
          maxBytes: CT_LIST_MAX_BYTES,
          maxRedirects: 2,
        },
        deps,
      );
      if (res.status !== 200) throw new Error(`crt.sh answered ${res.status}`);
      const parsed = crtShListSchema.safeParse(parseJsonText(res.body.toString("utf8")));
      if (!parsed.success) throw new Error("crt.sh answer is not a certificate list");
      return parsed.data.map((entry) => entry.id);
    },
    async fetch(id) {
      const res = await httpsRequest(
        { method: "GET", url: `https://crt.sh/?d=${id}`, timeoutMs: CT_TIMEOUT_MS, maxBytes: CT_CERT_MAX_BYTES, maxRedirects: 2 },
        deps,
      );
      if (res.status !== 200) throw new Error(`crt.sh answered ${res.status}`);
      return res.body.toString("utf8");
    },
  };
}

export interface CtWatchOptions {
  host: string;
  dataDir: string;
  clock: Clock;
  source: CtSource;
  onAlert(message: string): void;
}

export type CtRunResult = { kind: "ok"; checked: number } | { kind: "alert"; message: string } | { kind: "unavailable" };

export class CtWatch {
  private readonly opts: CtWatchOptions;
  private readonly seen = new Set<number>();
  private timer: Cancel | null = null;
  private stopped = false;
  private running = false;

  constructor(options: CtWatchOptions) {
    this.opts = options;
  }

  start(): void {
    this.schedule(CT_FIRST_CHECK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = this.opts.clock.schedule(ms, () => {
      this.timer = null;
      if (this.stopped) return;
      void this.run().finally(() => {
        if (!this.stopped) this.schedule(CT_INTERVAL_MS);
      });
    });
  }

  /** One bounded pass over entries not checked yet. */
  async run(): Promise<CtRunResult> {
    if (this.running || this.stopped) return { kind: "unavailable" };
    this.running = true;
    try {
      const { host, dataDir, source } = this.opts;
      // A `*.<base>` certificate covers this host too; crt.sh lists it only under that name.
      const dot = host.indexOf(".");
      const wildcard = dot > 0 ? `*${host.slice(dot)}` : null;
      let ids: number[];
      let known: string[];
      try {
        ids = await source.list(host);
        if (wildcard) ids = ids.concat(await source.list(wildcard));
        known = readKeyHistory(dataDir);
      } catch {
        return { kind: "unavailable" };
      }
      const fresh = [...new Set(ids)].filter((id) => !this.seen.has(id)).sort((a, b) => b - a).slice(0, CT_MAX_CERTS_PER_RUN);
      let checked = 0;
      for (const id of fresh) {
        let pem: string;
        try {
          pem = await source.fetch(id);
        } catch {
          continue;
        }
        if (this.stopped) return { kind: "unavailable" };
        let cert: X509Certificate;
        try {
          cert = new X509Certificate(pem);
        } catch {
          continue;
        }
        this.seen.add(id);
        if (cert.checkHost(host, { wildcards: true, subject: "never" }) === undefined) continue;
        checked++;
        // This PC never asks for a wildcard, so any wildcard for the base is someone else's.
        const names = (cert.subjectAltName ?? "").split(", ");
        if (wildcard && names.includes(`DNS:${wildcard}`)) {
          const message = `${CT_ALERT_PREFIX} a wildcard certificate ${wildcard} covering ${host} (crt.sh id ${id})`;
          this.opts.onAlert(message);
          return { kind: "alert", message };
        }
        if (!known.includes(spkiFingerprint(cert.publicKey))) {
          const message = `${CT_ALERT_PREFIX} a certificate for ${host} with a key this PC never made (crt.sh id ${id})`;
          this.opts.onAlert(message);
          return { kind: "alert", message };
        }
      }
      return { kind: "ok", checked };
    } finally {
      this.running = false;
    }
  }
}
