export function crashLogLine(kind, detail) {
  return `crash ${kind}: ${detail}`;
}

export function formatCrashError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeRenderGone(webContents, details) {
  const reason = details?.reason ?? "unknown";
  const exitCode = details?.exitCode ?? "";
  let url = "";
  try { url = webContents?.getURL?.() ?? ""; } catch {}
  return `reason=${reason} exitCode=${exitCode}${url ? ` url=${url}` : ""}`;
}

function describeChildGone(details) {
  const type = details?.type ?? "unknown";
  const reason = details?.reason ?? "unknown";
  const exitCode = details?.exitCode ?? "";
  const name = details?.name ? ` name=${details.name}` : "";
  return `type=${type} reason=${reason} exitCode=${exitCode}${name}`;
}

export function installMainCrashLogging({ process, app, log }) {
  const write = (kind, detail) => {
    try { log(crashLogLine(kind, detail)); } catch {}
  };
  process.on("uncaughtException", (error) => {
    write("uncaughtException", formatCrashError(error));
  });
  process.on("unhandledRejection", (reason) => {
    write("unhandledRejection", formatCrashError(reason));
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    write("render-process-gone", describeRenderGone(webContents, details));
  });
  app.on("child-process-gone", (_event, details) => {
    write("child-process-gone", describeChildGone(details));
  });
}
