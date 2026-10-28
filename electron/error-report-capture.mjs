import { createHmac, timingSafeEqual } from "node:crypto";
import { ERROR_SITES } from "../shared/error-report.mjs";
import { trustedTerminalSender } from "./terminal-host.mjs";

export function registerErrorReportIpc(ipc, reports, owner, origin) {
  const authorize = (event) => {
    if (!trustedTerminalSender(event, owner(), origin())) throw new Error("Untrusted error report caller");
  };
  ipc.handle("error-reports:get", (event) => { authorize(event); return reports.available() ? reports.consent() : null; });
  ipc.handle("error-reports:set", (event, value) => { authorize(event); return reports.setConsent(value); });
  ipc.on("error-reports:capture", (event, site) => {
    if (!trustedTerminalSender(event, owner(), origin())) return;
    if (site === ERROR_SITES.rendererError || site === ERROR_SITES.rendererRejection) reports.capture({ process: "renderer", code: "UNKNOWN_ERROR", site });
  });
}

export function installErrorReportCapture(app, reports, owner) {
  app.on("render-process-gone", (_event, contents, details) => {
    if (contents === owner() && details.reason !== "clean-exit") reports.capture({ process: "renderer", code: "RENDERER_GONE", site: ERROR_SITES.rendererGone, exitCode: details.exitCode });
  });
}

export async function handleServerErrorReport(req, res, token, reports) {
  const expected = createHmac("sha256", token).update("orbit-error-report-v1").digest("base64url");
  const received = Buffer.from(req.headers.authorization ?? "");
  const auth = Buffer.from(`Bearer ${expected}`);
  let status = 400;
  if (received.length !== auth.length || !timingSafeEqual(received, auth)) status = 401;
  else if (req.method !== "POST") status = 405;
  else {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) throw new Error("Report too large");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (Object.keys(input).length === 2 && input.code === "SERVER_RUNTIME_FAILURE" && input.site === ERROR_SITES.serverRuntime) {
        reports.capture({ process: "server", code: input.code, site: input.site });
        status = 204;
      }
    } catch {}
  }
  res.writeHead(status);
  res.end();
}
