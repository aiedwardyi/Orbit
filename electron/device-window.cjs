// Another PC's Orbit in its own sandboxed window, reached over its tailnet
// host. Access is that PC's one-time phone link cookie, kept in a persistent
// partition so the link is pasted once, never the local app's token.

const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");

const DEVICE_WINDOW_PARTITION = "persist:orbit-devices";
// Tailscale Serve names only: a synced record must never point a PC window at the public web.
const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;

function normalizedHost(raw) {
  const host = Object.prototype.toString.call(raw) === "[object String]" ? raw.trim().toLowerCase() : "";
  return host.length <= 253 && HOST_RE.test(host) ? host : "";
}

/** This PC's tailnet suffix from its own Serve host, or "" when unknown. */
function deviceTailnet(localHost) {
  const host = normalizedHost(localHost);
  const tailnet = host.slice(host.indexOf(".") + 1);
  return host && HOST_RE.test(tailnet) ? tailnet : "";
}

/** This PC's tailnet suffix from `tailscale status --json`, or "" when unreadable. */
function tailnetFromStatus(json) {
  try {
    const dnsName = JSON.parse(json)?.Self?.DNSName;
    return deviceTailnet(Object.prototype.toString.call(dnsName) === "[object String]" ? dnsName.replace(/\.$/, "") : "");
  } catch {
    return "";
  }
}

// Funnel sites on other tailnets are public *.ts.net too, so only this tailnet's machines pass.
function deviceWindowUrl(rawHost, tailnet) {
  const host = normalizedHost(rawHost);
  if (!host || !tailnet || host.slice(host.indexOf(".") + 1) !== tailnet) throw new Error("The PC address is invalid");
  return new URL(`https://${host}/`);
}

function deviceWindowTitle(rawName, host) {
  const name = Object.prototype.toString.call(rawName) === "[object String]" ? rawName.trim().slice(0, 64) : "";
  return `Wink - ${name || host}`;
}

/** Focuses the open window for `key`, or creates and tracks one until it closes. */
function openOrFocus(windows, key, create, refresh) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    refresh?.(existing);
    return existing;
  }
  const win = create();
  windows.set(key, win);
  win.once("closed", () => {
    if (windows.get(key) === win) windows.delete(key);
  });
  return win;
}

/** Shown when the PC answers 401: paste its phone link to mint the cookie. */
function deviceLinkPage({ host, title, heading, help, placeholder, submit, invalid }) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const script = `const host=${JSON.stringify(host)};const re=/^[a-f0-9]{64}$/;
document.querySelector("form").addEventListener("submit",(event)=>{event.preventDefault();
const value=document.querySelector("input").value.trim();let key=value;
try{const url=new URL(value);key=url.host===host&&url.pathname==="/remote"?url.searchParams.get("key"):"";}catch{}
if(!re.test(key||"")){document.querySelector("p[role=alert]").hidden=false;return;}
location.assign("https://"+host+"/remote?key="+key);});`;
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><html><meta name="color-scheme" content="dark"><title>${escape(title)}</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px system-ui,sans-serif">
        <form style="max-width:440px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">${escape(heading)}</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escape(help)}</p>
        <input autofocus spellcheck="false" placeholder="${escape(placeholder)}" style="box-sizing:border-box;width:100%;border:1px solid #3f3f46;border-radius:9px;background:#18181b;color:#f5f5f5;padding:9px 12px;font:13px ui-monospace,monospace">
        <p role="alert" hidden style="margin:10px 0 0;color:#f87171">${escape(invalid)}</p>
        <button style="margin-top:16px;border:0;border-radius:9px;background:#fff;color:#111;padding:9px 14px;font-weight:600;cursor:pointer">${escape(submit)}</button></form>
        <script>${script}</script>
      </body></html>`)
  );
}

/** Shown when the PC can't be reached; Retry reloads its own origin only. */
function deviceUnreachablePage({ host, title, heading, retry }) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const script = `const host=${JSON.stringify(host)};
document.querySelector("button").addEventListener("click",()=>location.assign("https://"+host+"/"));`;
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><html><meta name="color-scheme" content="dark"><title>${escape(title)}</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px system-ui,sans-serif">
        <div style="max-width:440px;padding:32px;text-align:center"><h2 style="margin:0 0 20px;font-size:18px">${escape(heading)}</h2>
        <button style="border:0;border-radius:9px;background:#fff;color:#111;padding:9px 14px;font-weight:600;cursor:pointer">${escape(retry)}</button></div>
        <script>${script}</script>
      </body></html>`)
  );
}

const LINKED_FILE_RE = /^\/api\/threads\/[\w-]+\/linked-file$/;
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A safe local name for a linked file on the PC's own origin, or "" for any other URL. */
function deviceLinkedFileName(rawUrl, origin) {
  if (!sameDesktopViewerOrigin(rawUrl, origin)) return "";
  const url = desktopViewerUrl(rawUrl);
  const filePath = url.searchParams.get("path");
  if (!LINKED_FILE_RE.test(url.pathname) || !filePath) return "";
  const base = filePath
    .split(/[\\/]/)
    .pop()
    // oxlint-disable-next-line no-control-regex -- Windows file names cannot hold control characters
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 && /^\.[a-z0-9]{1,16}$/i.test(base.slice(dot)) ? base.slice(dot) : "";
  const stem = (ext ? base.slice(0, dot) : base).replace(/^[. ]+/, "").slice(0, 120 - ext.length - 1) || "file";
  return `${RESERVED_NAME_RE.test(stem.split(".")[0]) ? "_" : ""}${stem}${ext}`;
}

const DEVICE_RETRY_MS = 10_000;
const DEVICE_RETRY_LIMIT_MS = 120_000;
const ERR_ABORTED = -3;

/** Swaps a failed, crashed or hung PC page for `failurePage` and retries `url` until a load commits. */
function watchDeviceLoad(webContents, { host, url, failurePage, log, setInterval: every = setInterval, clearInterval: stop = clearInterval, defer = (fn) => setTimeout(fn, 0) }) {
  let retry = null;
  let retries = 0;
  let failed = false;
  let showingFailure = false;
  const cancel = () => {
    if (retry) stop(retry);
    retry = null;
  };
  const showFailure = () => {
    if (webContents.isDestroyed()) return;
    showingFailure = true;
    void webContents.loadURL(failurePage).catch(() => {});
  };
  const fail = (detail, { crashed = false } = {}) => {
    if (!retry && retries === 0) log(`device window ${host}: ${detail}`);
    failed = true;
    // navigating inside render-process-gone can crash the main process before Electron 43.7.1
    if (crashed) defer(showFailure);
    else showFailure();
    if (retry || retries > 0) return;
    retry = every(() => {
      retries += 1;
      if (retries * DEVICE_RETRY_MS >= DEVICE_RETRY_LIMIT_MS) cancel();
      if (!webContents.isDestroyed()) void webContents.loadURL(url).catch(() => {});
    }, DEVICE_RETRY_MS);
  };
  webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED || String(validatedUrl).startsWith("data:")) return;
    fail(`did-fail-load ${code} ${description}`);
  });
  webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason !== "clean-exit") fail(`render-process-gone ${details?.reason ?? "unknown"}`, { crashed: true });
  });
  webContents.on("unresponsive", () => fail("unresponsive"));
  webContents.on("did-navigate", (_event, target) => {
    // only the failure page keeps retrying; the device link form must not be reloaded away
    if (showingFailure && String(target).startsWith("data:")) {
      showingFailure = false;
      return;
    }
    showingFailure = false;
    cancel();
    retries = 0;
    failed = false;
  });
  webContents.once("destroyed", cancel);
  return {
    /** Reloads a window left on the failure page, a crash or nothing at all. */
    reloadIfStuck() {
      if (webContents.isDestroyed() || !(failed || !webContents.getURL() || webContents.isCrashed())) return;
      void webContents.loadURL(url).catch(() => {});
    },
  };
}

module.exports = { DEVICE_WINDOW_PARTITION, deviceLinkPage, deviceLinkedFileName, deviceUnreachablePage, watchDeviceLoad, deviceTailnet, deviceWindowTitle, deviceWindowUrl, openOrFocus, tailnetFromStatus };
