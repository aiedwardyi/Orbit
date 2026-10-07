// Creates a new operator key in a private file (0600, refuses to overwrite)
// and prints only its public half.
//
//   node scripts/gen-operator-key.ts --out <file>

import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) {
  process.stderr.write("usage: gen-operator-key --out <file>\n");
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
try {
  await writeFile(values.out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
} catch (error) {
  process.stderr.write(`gen-operator-key: ${(error as NodeJS.ErrnoException).code ?? "write failed"}\n`);
  process.exit(1);
}
const x = publicKey.export({ format: "jwk" }).x;
process.stdout.write(`operator public key (base64url raw): ${x}\n`);
