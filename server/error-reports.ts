import { createHmac } from "node:crypto";
import { ERROR_SITES } from "../shared/error-report.mjs";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

export async function reportServerFailure(access: TerminalBridgeAccess | null): Promise<void> {
  if (!access) return;
  try {
    const url = new URL(access.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return;
    const grant = createHmac("sha256", access.token).update("orbit-error-report-v1").digest("base64url");
    const response = await fetch(`${url.origin}/v1/error-reports`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "SERVER_RUNTIME_FAILURE", site: ERROR_SITES.serverRuntime }),
    });
    await response.body?.cancel();
  } catch {}
}
