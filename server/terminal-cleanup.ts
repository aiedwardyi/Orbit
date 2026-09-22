import { terminalReadGrant } from "./terminal-grant.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

export async function closeBotPanes(
  access: TerminalBridgeAccess | null,
  botId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!access) return;
  const url = `${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal`;
  const headers = { authorization: `Bearer ${terminalReadGrant(access.token, botId)}`, "content-type": "application/json" };
  const res = await fetchImpl(url, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`terminal cleanup: HTTP ${res.status}`);
}
