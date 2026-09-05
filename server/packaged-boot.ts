// Packaged Electron entry. Bind health + static UI immediately, then load
// the fat harness so first chat paint is not stuck on module evaluation.

import { startEarlyListen } from "./early-listen.ts";

const PORT = Number(process.env.OMB_PORT ?? process.env.OGB_PORT ?? 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;

startEarlyListen({ port: PORT, staticDir: STATIC_DIR });
// Resolved at runtime so the bundled boot stays 3kb and loads the sibling
// fat harness after /api/health is already listening.
await import(new URL("./index.js", import.meta.url).href);
