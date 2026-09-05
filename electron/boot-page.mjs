// Packaged first-paint helpers. The harness child serves the real UI, but
// Chromium can show a skin-colored connecting page immediately — before
// /api/health answers — so cold launch is not a blank window.

export function buildConnectingPage({ locale, fontStack, backgroundColor, message }) {
  const lang = escapeHtml(String(locale ?? "en"));
  const font = escapeHtml(String(fontStack ?? "system-ui,sans-serif"));
  const background = escapeHtml(String(backgroundColor ?? "#070707"));
  const copy = escapeHtml(String(message ?? ""));
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<html lang="${lang}"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:${background};color:#fcfcfc;font:15px ${font}"><div style="text-align:center;max-width:360px"><p style="color:#fcfcfc99;line-height:1.5">${copy}</p></div></body></html>`,
    )
  );
}

export function isPackagedAppUrl(url, port) {
  try {
    const parsed = new URL(String(url ?? ""));
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port === String(port) &&
      (parsed.pathname === "/" || parsed.pathname === "")
    );
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
