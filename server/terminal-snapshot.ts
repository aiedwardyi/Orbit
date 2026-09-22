import { terminalReadGrant } from "./terminal-grant.ts";

export type TerminalBridgeAccess = { url: string; token: string };

const SNAPSHOT_FIELDS = ["screenText", "recentText", "state", "sessionId", "generation", "cwd", "exited", "exitCode"] as const;

/** Read-only terminal snapshot for clients without the Electron preload (remote browsers). */
export async function terminalSnapshotResponse(
  access: TerminalBridgeAccess | null,
  botId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!access) return { status: 503, body: { error: "terminal bridge unavailable" } };
  let res: Response;
  try {
    res = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal`, {
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { status: 502, body: { error: "terminal bridge unreachable" } };
  }
  if (!res.ok) return { status: 502, body: { error: `terminal bridge: HTTP ${res.status}` } };
  const snapshot = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const key of SNAPSHOT_FIELDS) if (snapshot[key] !== undefined) body[key] = snapshot[key];
  return { status: 200, body };
}

export async function raisePaneAttention(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!access) return;
  try {
    await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/attention`, {
      method: "POST",
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {}
}
