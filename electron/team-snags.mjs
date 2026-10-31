import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Queues a stuck-worker report for the server, which owns the folder and scrubs before sending. */
export function spoolTeamSnag(dir, consent, snag, now = Date.now) {
  let tmp;
  try {
    if (!fs.existsSync(dir) || !consent()) return false;
    const id = randomBytes(16).toString("hex");
    const at = now();
    const file = path.join(dir, `${at}-${id}.json`);
    tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...snag, id, at }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
}
