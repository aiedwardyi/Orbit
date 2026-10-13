// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export function writeFileAtomic(path: string, data: string, options: { mode?: number } = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // A brief Windows lock fails the rename, so retry it a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        break;
      } catch (e) {
        if (!(e instanceof Error && "code" in e && (e.code === "EPERM" || e.code === "EBUSY")) || attempt === 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}
