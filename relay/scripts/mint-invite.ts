// Mints an operator-signed enrollment invite (design section 4).
//
//   pnpm mint-invite --key-file <private operator key file> [--ttl-days 7]
//
// The key is read from a 0600 file, never from argv or env, and is never
// printed. Only the invite goes to stdout.

import { parseArgs } from "node:util";
import { mintInvite } from "../../shared/relay-protocol.ts";
import { readOperatorKey } from "../src/config.ts";

export async function mintInviteFromFile(keyFile: string, ttlDays = 7, now = Date.now()): Promise<string> {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 30) throw new Error("--ttl-days must be in (0, 30]");
  const key = await readOperatorKey(keyFile);
  return mintInvite(key, { now, ttlSec: Math.round(ttlDays * 86400) });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "key-file": { type: "string" }, "ttl-days": { type: "string", default: "7" } },
  });
  if (!values["key-file"]) throw new Error("usage: mint-invite --key-file <file> [--ttl-days 7]");
  process.stdout.write(`${await mintInviteFromFile(values["key-file"], Number(values["ttl-days"]))}\n`);
}

if (process.argv[1] && /mint-invite\.(ts|mjs)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`mint-invite: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
