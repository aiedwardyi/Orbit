// Used invite nonces (design section 4). Only SHA-256 hashes are stored, one
// "<hex> <exp>" line each in a single append-only file; a nonce never becomes
// a path. consume() is synchronous, so two concurrent enrollments cannot both
// pass it.

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOCK_SKEW_SEC } from "../../shared/relay-protocol.ts";

const FILE = "used-invites";
const LINE_RE = /^([0-9a-f]{64}) (\d{1,12})$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function nonceHash(nonce: string): string {
  return createHash("sha256").update("wink-invite-nonce/1\0").update(nonce, "utf8").digest("hex");
}

export class InviteStore {
  private readonly used = new Map<string, number>();
  private readonly path: string;
  private writes: Promise<void> = Promise.resolve();

  private constructor(dir: string) {
    this.path = join(dir, FILE);
  }

  /** Loads the store and rewrites it without entries past their expiry. */
  static async open(dir: string, now: () => number = Date.now): Promise<InviteStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const store = new InviteStore(dir);
    let text = "";
    try {
      const handle = await open(store.path, "r");
      try {
        const { size } = await handle.stat();
        if (size > MAX_FILE_BYTES) throw new Error("used-invites file is too large");
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      // SAFETY: fs rejects with Node errno errors.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const cutoff = Math.floor(now() / 1000) - CLOCK_SKEW_SEC;
    for (const line of text.split("\n")) {
      const m = LINE_RE.exec(line);
      if (m && Number(m[2]) >= cutoff) store.used.set(m[1], Number(m[2]));
    }
    const tmp = `${store.path}.tmp`;
    await writeFile(tmp, store.serialize(), { mode: 0o600 });
    await rename(tmp, store.path);
    return store;
  }

  get size(): number {
    return this.used.size;
  }

  has(nonce: string): boolean {
    return this.used.has(nonceHash(nonce));
  }

  /**
   * Marks the nonce used. False when it already was. Synchronous on purpose:
   * the check and the mark happen in one turn of the event loop.
   */
  consume(nonce: string, exp: number): boolean {
    const hash = nonceHash(nonce);
    if (this.used.has(hash)) return false;
    this.used.set(hash, exp);
    return true;
  }

  /** Appends a consumed nonce durably. The in-memory mark stays even if this fails. */
  persist(nonce: string, exp: number): Promise<void> {
    const line = `${nonceHash(nonce)} ${exp}\n`;
    const write = this.writes.then(async () => {
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  /** Reads the file back; used by tests. */
  async readRaw(): Promise<string> {
    return readFile(this.path, "utf8");
  }

  private serialize(): string {
    let out = "";
    for (const [hash, exp] of this.used) out += `${hash} ${exp}\n`;
    return out;
  }
}
