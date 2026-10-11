// Bakes the release's Google sign-in client into the package from the env.
// The repo never holds it; without both values sign-in stays hidden.
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? fileURLToPath(new URL("../electron/google-client.json", import.meta.url));
const id = process.env.WINK_GOOGLE_CLIENT_ID?.trim();
const secret = process.env.WINK_GOOGLE_CLIENT_SECRET?.trim();
if (id && secret) {
  writeFileSync(target, JSON.stringify({ id, secret }));
  console.log("Google sign-in client baked in.");
} else {
  rmSync(target, { force: true });
  console.log("No Google sign-in client: sign-in stays hidden in this build.");
}
