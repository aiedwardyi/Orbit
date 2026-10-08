// Revoked labels (design section 4): one label per line, `#` comments.
// Reloaded on SIGHUP and when the file's mtime changes.

import { readFile, stat } from "node:fs/promises";
import { LABEL_RE } from "../../shared/relay-protocol.ts";
import { silentLogger, type Logger } from "./log.ts";

const MAX_BYTES = 4 * 1024 * 1024;

export class RevocationList {
  private labels = new Set<string>();
  private mtimeMs = -1;
  private readonly path: string | undefined;

  constructor(path: string | undefined, private readonly log: Logger = silentLogger) {
    this.path = path;
  }

  has(label: string): boolean {
    return this.labels.has(label);
  }

  get size(): number {
    return this.labels.size;
  }

  /** Reload failures retain the last good list. */
  async reload(force = false): Promise<string[]> {
    if (!this.path) return [];
    let text: string;
    let mtimeMs: number;
    try {
      const info = await stat(this.path);
      if (!force && info.mtimeMs === this.mtimeMs) return [];
      if (info.size > MAX_BYTES) throw new Error("revocation file is too large");
      mtimeMs = info.mtimeMs;
      text = await readFile(this.path, "utf8");
    } catch (error) {
      // SAFETY: fs rejects with Node errno errors.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.log.log("revocation-reload-failed", { reason: missing ? "missing" : "read-failed" });
      this.mtimeMs = -1;
      return [];
    }
    const next = new Set<string>();
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim().toLowerCase();
      if (LABEL_RE.test(line)) next.add(line);
    }
    const added = [...next].filter((label) => !this.labels.has(label));
    this.labels = next;
    this.mtimeMs = mtimeMs;
    return added;
  }
}
