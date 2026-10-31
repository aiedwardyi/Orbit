import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Queues a stuck-worker report for the server, which owns the folder and scrubs before sending. */
export function spoolTeamSnag(dir, consent, snag, now = Date.now) {
  try {
    if (!fs.existsSync(dir) || !consent()) return false;
    const id = randomBytes(16).toString("hex");
    const at = now();
    const file = path.join(dir, `${at}-${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...snag, id, at }));
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}
