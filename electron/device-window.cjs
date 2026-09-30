// Another PC's Orbit in its own sandboxed window, reached over its tailnet
// host. Access is that PC's one-time phone link cookie, kept in a persistent
// partition so the link is pasted once, never the local app's token.

const DEVICE_WINDOW_PARTITION = "persist:orbit-devices";
// Tailscale Serve names only: a synced record must never point a PC window at the public web.
const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;

function deviceWindowUrl(rawHost) {
  const host = Object.prototype.toString.call(rawHost) === "[object String]" ? rawHost.trim().toLowerCase() : "";
  if (host.length > 253 || !HOST_RE.test(host)) throw new Error("The PC address is invalid");
  return new URL(`https://${host}/`);
}

function deviceWindowTitle(rawName, host) {
  const name = Object.prototype.toString.call(rawName) === "[object String]" ? rawName.trim().slice(0, 64) : "";
  return `Orbit - ${name || host}`;
}

/** Focuses the open window for `key`, or creates and tracks one until it closes. */
function openOrFocus(windows, key, create) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
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

module.exports = { DEVICE_WINDOW_PARTITION, deviceLinkPage, deviceWindowTitle, deviceWindowUrl, openOrFocus };
