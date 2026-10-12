// Bakes the release's Google sign-in client into the package from the env.
// The repo never holds it; without both values sign-in stays hidden, and
// without the web client id the phone's Google button does.
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? fileURLToPath(new URL("../electron/google-client.json", import.meta.url));
const id = process.env.WINK_GOOGLE_CLIENT_ID?.trim();
const secret = process.env.WINK_GOOGLE_CLIENT_SECRET?.trim();
const webId = process.env.WINK_GOOGLE_WEB_CLIENT_ID?.trim();
if (id && secret) {
  writeFileSync(target, JSON.stringify(webId ? { id, secret, webId } : { id, secret }));
  console.log(webId ? "Google sign-in client baked in, with phone sign-in." : "Google sign-in client baked in, without phone sign-in.");
} else {
  rmSync(target, { force: true });
  console.log("No Google sign-in client: sign-in stays hidden in this build.");
}
