import { createHmac } from "node:crypto";

export const TERMINAL_GRANT_PREFIX = "orbit-terminal-read-v1";
export const UPDATE_GRANT_PREFIX = "orbit-update-v1";

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function terminalReadGrant(token: string, botId: string): string {
  if (!token || !BOT_ID_RE.test(botId)) throw new Error("the shared terminal grant is invalid");
  return createHmac("sha256", token).update(`${TERMINAL_GRANT_PREFIX}:${botId}`).digest("base64url");
}

export function updateGrant(token: string): string {
  if (!token) throw new Error("the shared update grant is invalid");
  return createHmac("sha256", token).update(UPDATE_GRANT_PREFIX).digest("base64url");
}
