// Packaged Electron entry. Bind health + static UI immediately, then load
// the fat harness so first chat paint is not stuck on module evaluation.

import { randomBytes } from "node:crypto";
import { startEarlyListen } from "./early-listen.ts";

const PORT = Number(process.env.OMB_PORT ?? process.env.OGB_PORT ?? 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;

/** Same shape as electron/local-api-auth.mjs + server/index.ts. */
const COMMS_TOKEN_RE = /^[a-f0-9]{48}$/;

function issuePackagedCommsToken(): string {
  const existing = process.env.OMB_COMMS_TOKEN;
  if (typeof existing === "string" && COMMS_TOKEN_RE.test(existing)) return existing;
  const token = randomBytes(24).toString("hex");
  process.env.OMB_COMMS_TOKEN = token;
  return token;
}

function postAppToken(token: string): void {
  const message = { type: "orbit:api-token" as const, token };
  const parentPort = (process as NodeJS.Process & {
    parentPort?: { postMessage(message: { type: string; token: string }): void };
  }).parentPort;
  parentPort?.postMessage(message);
  process.send?.(message);
}

startEarlyListen({ port: PORT, staticDir: STATIC_DIR });
// Mint + deliver the app token before fat import so main can pass
// waitForAppToken once identity (/api/health) is ready — without waiting
// on the ~1.9MB harness module evaluation. index.js reuses OMB_COMMS_TOKEN.
postAppToken(issuePackagedCommsToken());
// Resolved at runtime so the bundled boot stays small and loads the sibling
// fat harness after /api/health is already listening.
await import(new URL("./index.js", import.meta.url).href);
