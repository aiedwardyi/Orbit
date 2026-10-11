import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
const memoryDeviceSchema = z.string().regex(/^[0-9a-f]{12}$/);
export const driveOwnIdsSchema = z.object({
  profileDeviceId: idSchema, writerId: idSchema, memoryDeviceId: memoryDeviceSchema,
}).strict();
export type DriveOwnIds = z.infer<typeof driveOwnIdsSchema>;

export class DriveIdentityError extends Error {
  constructor() {
    super("Drive mirror engine identities are unavailable or inconsistent");
    this.name = "DriveIdentityError";
  }
}

export function readDriveOwnIds(dataDir: string): DriveOwnIds {
  let database: DatabaseSync | undefined;
  try {
    const profile = z.object({ deviceId: idSchema }).parse(JSON.parse(readFileSync(join(dataDir, "profile-sync.json"), "utf8")));
    const memory = z.object({ device: memoryDeviceSchema }).parse(JSON.parse(readFileSync(join(dataDir, "memory-sync-v2.json"), "utf8")));
    database = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    const identity = z.object({ device: idSchema, writer: idSchema }).parse(database.prepare("SELECT device, writer FROM sync_v2_identity WHERE id = 1").get());
    if (identity.device !== profile.deviceId) throw new DriveIdentityError();
    return { profileDeviceId: profile.deviceId, writerId: identity.writer, memoryDeviceId: memory.device };
  } catch {
    throw new DriveIdentityError();
  } finally {
    database?.close();
  }
}
