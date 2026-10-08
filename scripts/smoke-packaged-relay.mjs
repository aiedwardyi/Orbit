// Set up phone access in the packaged server, started the way Electron starts
// it. The relay client loads lazily, so /api/health never proves it loads.
// The placeholder code names example.invalid: no secret, no relay traffic.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { waitForAppToken } from "../electron/local-api-auth.mjs";

const resources = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), "wink-relay-smoke-"));
const port = 21988;
const child = spawn(process.execPath, [join(resources, "server", "packaged-boot.js")], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_STATIC_DIR: join(resources, "ui"),
    OMB_RESOURCES_PATH: resources,
    OMB_SKILLS_DIR: join(resources, "skills"),
    OMB_USER_DATA: home,
    OMB_PACKAGED: "1",
    ORBIT_REMOTE_AUTO: "0",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

/** What went wrong, or null once the relay client loaded and refused the placeholder code. */
async function smoke() {
  const token = await waitForAppToken(child, 60_000);
  if (!token) return "the packaged server sent no app token";
  const call = async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const deadline = Date.now() + 90_000;
  while ((await call("/api/phone-relay/status").catch(() => null))?.status !== 200) {
    if (child.exitCode !== null || Date.now() > deadline) return "the packaged harness never answered /api/phone-relay/status";
    await sleep(500);
  }
  const setup = await call("/api/phone-relay/setup", { method: "POST", body: JSON.stringify({ code: "wks1:example.invalid:wki1.AAAA.BBBB" }) });
  console.log(`setup answered ${setup.status}: ${setup.body?.error}`);
  if (setup.status < 400 || setup.status >= 500 || /Dynamic require/.test(String(setup.body?.error))) {
    return "setup with the placeholder code must end in a 4xx enrollment error";
  }
  const status = await call("/api/phone-relay/status");
  return status.body?.state === "enrolling" ? null : `the relay client did not start: ${JSON.stringify(status.body)}`;
}

const problem = await smoke().catch((error) => error.message);
if (problem) {
  console.error(`::error::${problem}`);
  console.error(output.trim() || "(no server output)");
  process.exitCode = 1;
} else {
  console.log("packaged server loaded the relay client and refused the placeholder code");
}
// process.exit() here aborts Node on Windows (libuv UV_HANDLE_CLOSING), so let the loop drain.
child.kill();
