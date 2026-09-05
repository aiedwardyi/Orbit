// Packaged first-paint helpers. The harness child serves the real UI, but
// Chromium can show a skin-colored connecting page immediately — before
// /api/health answers — so cold launch is not a blank window.

export const BOOT_CONNECTING = "connecting";
export const BOOT_READY = "ready";
export const BOOT_FAILED = "failed";

const BOOT_MARKER = (phase) => `data-orbit-boot="${phase}"`;

export function buildConnectingPage({ locale, fontStack, backgroundColor, message }) {
  const lang = escapeHtml(String(locale ?? "en"));
  const font = escapeHtml(String(fontStack ?? "system-ui,sans-serif"));
  const background = escapeHtml(String(backgroundColor ?? "#070707"));
  const copy = escapeHtml(String(message ?? ""));
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<html lang="${lang}" ${BOOT_MARKER(BOOT_CONNECTING)}><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:${background};color:#fcfcfc;font:15px ${font}"><div style="text-align:center;max-width:360px"><p style="color:#fcfcfc99;line-height:1.5">${copy}</p></div></body></html>`,
    )
  );
}

export function isPackagedAppUrl(url, port) {
  try {
    const parsed = new URL(String(url ?? ""));
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === String(port) && parsed.pathname === "/";
  } catch {
    return false;
  }
}

export function bootPagePhase(url) {
  const html = dataHtml(url);
  if (html.includes(BOOT_MARKER(BOOT_CONNECTING))) return BOOT_CONNECTING;
  if (html.includes(BOOT_MARKER(BOOT_FAILED))) return BOOT_FAILED;
  return null;
}

export function isConnectingPageUrl(url) {
  return bootPagePhase(url) === BOOT_CONNECTING;
}

export function isFailedBootPageUrl(url) {
  return bootPagePhase(url) === BOOT_FAILED;
}

export function shouldDeliverPackageInstall(url, _port) {
  return !isConnectingPageUrl(url) && !isFailedBootPageUrl(url);
}

export function shouldStartPackagedSmoke(url, port) {
  return isPackagedAppUrl(url, port) || isFailedBootPageUrl(url);
}

export function shouldReloadPackagedWindow(currentUrl, port, phase) {
  if (phase === BOOT_READY) return !isPackagedAppUrl(currentUrl, port);
  if (phase === BOOT_FAILED) return !isFailedBootPageUrl(currentUrl);
  return !isConnectingPageUrl(currentUrl);
}

export function markFailedBootPage(html) {
  return String(html ?? "").replace(/<html\b/i, `<html ${BOOT_MARKER(BOOT_FAILED)}`);
}

function dataHtml(url) {
  const raw = String(url ?? "");
  if (!raw.startsWith("data:text/html")) return "";
  const comma = raw.indexOf(",");
  if (comma === -1) return "";
  try {
    return decodeURIComponent(raw.slice(comma + 1));
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
