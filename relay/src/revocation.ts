// Revoked labels (design section 4): one label per line, `#` comments.
// Reloaded on SIGHUP and when the file's mtime changes.

import { readFile, stat } from "node:fs/promises";
import { LABEL_RE } from "../../shared/relay-protocol.ts";

const MAX_BYTES = 4 * 1024 * 1024;

export class RevocationList {
  private labels = new Set<string>();
  private mtimeMs = -1;
  private readonly path: string | undefined;

  constructor(path: string | undefined) {
    this.path = path;
  }

  has(label: string): boolean {
    return this.labels.has(label);
  }

  get size(): number {
    return this.labels.size;
  }

  /**
   * Re-reads the file when it changed. Returns labels that became revoked.
   * A missing file means nothing is revoked; an unreadable one keeps the old list.
   */
  async reload(force = false): Promise<string[]> {
    if (!this.path) return [];
    let text: string;
    try {
      const info = await stat(this.path);
      if (!force && info.mtimeMs === this.mtimeMs) return [];
      if (info.size > MAX_BYTES) return [];
      this.mtimeMs = info.mtimeMs;
      text = await readFile(this.path, "utf8");
    } catch (error) {
      // SAFETY: fs rejects with Node errno errors.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.labels = new Set();
        this.mtimeMs = -1;
      }
      return [];
    }
    const next = new Set<string>();
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim().toLowerCase();
      if (LABEL_RE.test(line)) next.add(line);
    }
    const added = [...next].filter((label) => !this.labels.has(label));
    this.labels = next;
    return added;
  }
}
