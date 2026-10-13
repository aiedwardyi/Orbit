// Mints an operator-signed enrollment invite (design section 4).
//
//   pnpm mint-invite --key-file <private operator key file> [--ttl-days 7] [--base <domain>] [--test]
//
// The key is read from a 0600 file, never from argv or env, and is never
// printed. Only the invite goes to stdout; with --base, the one-line setup
// code (wks1:<base>:<invite>) a teammate pastes into Settings. --test marks
// the invite so the PC it enrolls stays off the team page.

import { parseArgs } from "node:util";
import { RELAY_BASE_RE, buildSetupCode, mintInvite } from "../../shared/relay-protocol.ts";
import { readOperatorKey } from "../src/config.ts";

export async function mintInviteFromFile(keyFile: string, ttlDays = 7, now = Date.now(), test = false): Promise<string> {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 30) throw new Error("--ttl-days must be in (0, 30]");
  const key = await readOperatorKey(keyFile);
  return mintInvite(key, { now, ttlSec: Math.round(ttlDays * 86400), test });
}

/** The setup code for `base`, or the bare invite without one. */
export async function mintFromFile(keyFile: string, options: { ttlDays?: number; base?: string; now?: number; test?: boolean } = {}): Promise<string> {
  const base = options.base?.trim().toLowerCase();
  if (base !== undefined && !RELAY_BASE_RE.test(base)) throw new Error("--base must be a domain name like wink.example.com");
  const invite = await mintInviteFromFile(keyFile, options.ttlDays, options.now, options.test);
  return base === undefined ? invite : buildSetupCode(base, invite);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "key-file": { type: "string" },
      "ttl-days": { type: "string", default: "7" },
      base: { type: "string" },
      test: { type: "boolean", default: false },
    },
  });
  if (!values["key-file"]) throw new Error("usage: mint-invite --key-file <file> [--ttl-days 7] [--base <domain>] [--test]");
  const options = { ttlDays: Number(values["ttl-days"]), base: values.base, test: values.test };
  process.stdout.write(`${await mintFromFile(values["key-file"], options)}\n`);
}

if (process.argv[1] && /mint-invite\.(ts|mjs)$/.test(process.argv[1])) {
  main().catch((cause: unknown) => {
    process.stderr.write(`mint-invite: ${cause instanceof Error ? cause.message : "failed"}\n`);
    process.exit(1);
  });
}
