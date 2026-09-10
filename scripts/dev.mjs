import { fork, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { waitForAppToken } from "../electron/local-api-auth.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.OMB_PORT || process.env.OGB_PORT || "8799";
const children = new Set();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
function own(child) {
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
    stop();
  });
  return child;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const harness = own(fork(fileURLToPath(new URL("../server/index.ts", import.meta.url)), [], {
    cwd: root,
    env: { ...process.env, OMB_PORT: port },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  }));
  const token = await waitForAppToken(harness, 60_000);
  if (!token) throw new Error("The development harness did not provide its app credential");
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (stopping || Date.now() > deadline) throw new Error("The development harness did not become ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (health.pid !== harness.pid) throw new Error("The development harness port belongs to another process");
      if (response.ok) break;
    } catch (error) {
      if (error.message?.includes("another process")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const env = { ...process.env, OMB_PORT: port, OMB_COMMS_TOKEN: token };
  const vite = own(spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--strictPort"], {
    cwd: root, env, stdio: "inherit",
  }));
  if (process.argv.includes("--desktop")) {
    const ui = process.env.ELECTRON_START_URL || `http://127.0.0.1:${process.env.OMB_UI_PORT || 5199}`;
    const uiDeadline = Date.now() + 20_000;
    while (!stopping && vite.exitCode === null && Date.now() <= uiDeadline) {
      try {
        if ((await fetch(ui, { signal: AbortSignal.timeout(500) })).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (stopping) throw new Error("The development UI stopped before becoming ready");
    if (vite.exitCode !== null) throw new Error("The development UI exited before becoming ready");
    if (Date.now() > uiDeadline) throw new Error("The development UI did not become ready");
    if (!stopping && vite.exitCode === null) own(spawn(require("electron"), ["."], { cwd: root, env, stdio: "inherit" }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  stop();
}
