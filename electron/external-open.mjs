/** URLs the desktop may hand to shell.openExternal from renderer-controlled
 * window.open / target=_blank. file:, javascript:, and other privileged
 * schemes stay closed — including the packaged boot page's server.log path. */
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function safeExternalUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
