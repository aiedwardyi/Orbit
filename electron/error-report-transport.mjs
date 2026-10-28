import http from "node:http";
import https from "node:https";

// Builders set electron/error-report-config.json; an empty DSN disables capture and queue writes.

export function errorReportEndpoint(dsn) {
  try {
    const url = new URL(dsn);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) return null;
    if (!/^[a-zA-Z0-9]{1,128}$/.test(url.username) || url.password || !/^\/\d{1,12}$/.test(url.pathname) || url.search || url.hash) return null;
    const key = url.username;
    const project = url.pathname.slice(1);
    url.username = "";
    url.pathname = `/api/${project}/store/`;
    url.search = `sentry_version=7&sentry_key=${key}`;
    return url;
  } catch {
    return null;
  }
}

// Sentry store: ID/hour/code/build map to event_id/timestamp/message/release; remaining facts use tags/extra.
export function errorReportBytes(report) {
  return JSON.stringify({
    event_id: report.reportId, timestamp: report.utcHour * 3600, message: report.code, release: report.build,
    tags: { platform: report.platform, arch: report.arch, process: report.process, site: String(report.site) },
    extra: { schema: report.schema, exitCode: report.exitCode, count: report.count, uptimeBucket: report.uptimeBucket },
  });
}

export function postErrorReport(endpoint, report, signal, timeoutMs = 10000) {
  const body = errorReportBytes(report);
  return new Promise((resolve) => {
    const request = (endpoint.protocol === "https:" ? https : http).request(endpoint, {
      method: "POST", agent: false, signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const status = response.statusCode;
      const retryAfter = response.headers["retry-after"];
      response.destroy();
      resolve({ status, retryAfter });
    });
    const timer = setTimeout(() => request.destroy(), timeoutMs);
    request.once("close", () => clearTimeout(timer));
    request.once("error", () => resolve({ status: 0 }));
    request.end(body);
  });
}
