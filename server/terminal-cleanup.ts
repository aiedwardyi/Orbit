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
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`terminal cleanup: HTTP ${res.status}`);
  const snapshot = await res.json() as { panes?: Array<{ sessionId: string; main: boolean }> };
  await Promise.all((snapshot.panes ?? []).filter((pane) => !pane.main).map(async (pane) => {
    const closed = await fetchImpl(`${url}/close`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: pane.sessionId }), signal: AbortSignal.timeout(5_000),
    });
    if (!closed.ok && closed.status !== 409) throw new Error(`terminal cleanup: HTTP ${closed.status}`);
  }));
}
