import { z } from "zod";
import { terminalPaneCountsGrant, terminalReadGrant, terminalSendGrant } from "./terminal-grant.ts";
import { TERMINAL_KEYS } from "./terminal-keys.ts";

export type TerminalBridgeAccess = { url: string; token: string };

const SNAPSHOT_FIELDS = ["screenText", "screenRuns", "recentText", "state", "sessionId", "generation", "cwd", "exited", "exitCode", "label", "panes"] as const;
export const TERMINAL_SEND_MAX_BYTES = 4 * 1024;
// ESC covers kitty-mode keys like \x1b[99;5u (Ctrl+C); tab and newlines stay allowed.
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const terminalSendSchema = z.union([
  z.object({ sessionId: z.string().min(1), generation: z.number().int(), text: z.string(), paste: z.boolean().optional() }),
  z.object({ sessionId: z.string().min(1), generation: z.number().int(), key: z.enum(["up", "down", "enter", "esc"]) }),
]);

function snapshotBody(snapshot: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of SNAPSHOT_FIELDS) if (snapshot[key] !== undefined) body[key] = snapshot[key];
  // Pane screens feed the MCP pane list only.
  if (Array.isArray(body.panes)) body.panes = body.panes.map(({ screenText: _screenText, ...pane }) => pane);
  return body;
}

const BOT_ID = /^[\w-]{1,128}$/;
const bridgeErrorSchema = z.object({ error: z.string().optional() }).catch({});
const bridgeSnapshotSchema = z.record(z.string(), z.unknown()).catch({});
const paneCountsSchema = z.object({
  counts: z.record(z.string(), z.number()).optional(),
  panes: z.record(z.string(), z.array(z.string())).optional(),
});

export type PaneCounts = { counts: Record<string, number>; panes: Record<string, string[]> };

/** Drops anything the bridge did not prove is a live worker pane. Counts follow the label lists. */
export function acceptedPaneCounts(body: { counts?: Record<string, number>; panes?: Record<string, string[]> }): PaneCounts {
  const panes: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const [botId, labels] of Object.entries(body.panes ?? {})) {
    if (!BOT_ID.test(botId) || labels.length < 1 || labels.length > 8) continue;
    const names = labels.map((label) => label.slice(0, 40));
    panes[botId] = names;
    counts[botId] = names.length;
  }
  if (Object.keys(panes).length > 0) return { counts, panes };
  for (const [botId, count] of Object.entries(body.counts ?? {})) {
    const parsed = z.number().int().min(1).max(8).safeParse(count);
    if (!BOT_ID.test(botId) || !parsed.success) continue;
    counts[botId] = parsed.data;
  }
  return { counts, panes };
}

/** Read-only worker-pane counts for clients without the Electron preload. */
export async function terminalPaneCountsResponse(
  access: TerminalBridgeAccess | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: PaneCounts | { error: string } }> {
  if (!access) return { status: 503, body: { error: "terminal bridge unavailable" } };
  let res: Response;
  try {
    res = await fetchImpl(`${access.url}/v1/terminal/pane-counts`, {
      headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { status: 502, body: { error: "terminal bridge unreachable" } };
  }
  if (!res.ok) return { status: 502, body: { error: `terminal bridge: HTTP ${res.status}` } };
  const parsed = paneCountsSchema.safeParse(await res.json().catch(() => ({})));
  if (!parsed.success) return { status: 502, body: { error: "terminal bridge: bad pane counts" } };
  return { status: 200, body: acceptedPaneCounts(parsed.data) };
}

/** Read-only terminal snapshot for clients without the Electron preload (remote browsers). */
export async function terminalSnapshotResponse(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!access) return { status: 503, body: { error: "terminal bridge unavailable" } };
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  let res: Response;
  try {
    res = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal${qs}`, {
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { status: 502, body: { error: "terminal bridge unreachable" } };
  }
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404 || /unknown terminal/i.test(errorBody.error ?? "")) {
      return { status: 404, body: { error: "Unknown terminal" } };
    }
    return { status: 502, body: { error: `terminal bridge: HTTP ${res.status}` } };
  }
  return { status: 200, body: snapshotBody((await res.json().catch(() => ({}))) as Record<string, unknown>) };
}

/** Starts the bot's main shell on the desktop for a remote browser; answers its snapshot. */
export async function terminalStartResponse(
  access: TerminalBridgeAccess | null,
  botId: string,
  fetchImpl: typeof fetch = fetch,
): ReturnType<typeof terminalSnapshotResponse> {
  if (!access) return { status: 503, body: { error: "terminal bridge unavailable" } };
  let res: Response;
  try {
    // A cold Windows shell can take most of the host's 15 s readiness window.
    res = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/main`, {
      method: "POST",
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 502, body: { error: "terminal bridge unreachable" } };
  }
  if (!res.ok) {
    const errorBody = bridgeErrorSchema.parse(await res.json().catch(() => ({})));
    return { status: 502, body: { error: errorBody.error ?? `terminal bridge: HTTP ${res.status}` } };
  }
  return { status: 200, body: snapshotBody(bridgeSnapshotSchema.parse(await res.json().catch(() => ({})))) };
}

/** Sends a line from a remote browser with a send-only grant; answers the post-send snapshot. */
export async function terminalSendResponse(
  access: TerminalBridgeAccess | null,
  botId: string,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = terminalSendSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "sessionId, generation and text or key are required" } };
  const { sessionId, generation } = parsed.data;
  let text: string;
  if ("key" in parsed.data) {
    text = TERMINAL_KEYS[parsed.data.key];
  } else {
    text = parsed.data.text;
    if (Buffer.byteLength(text, "utf8") > TERMINAL_SEND_MAX_BYTES) {
      return { status: 400, body: { error: `terminal input is capped at ${TERMINAL_SEND_MAX_BYTES / 1024}KB` } };
    }
    if (text.includes("\x03")) return { status: 400, body: { error: "Ctrl+C is not allowed" } };
    if (CONTROL_BYTES.test(text)) return { status: 400, body: { error: "control characters are not allowed" } };
    // Framed only after validation, so a sender can never supply its own ESC.
    if (parsed.data.paste) text = `\x1b[200~${text}\x1b[201~\n`;
  }
  if (!access) return { status: 503, body: { error: "terminal bridge unavailable" } };
  const send = { sessionId, generation, text };
  let res: Response;
  try {
    res = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${terminalSendGrant(access.token, botId)}`, "content-type": "application/json" },
      body: JSON.stringify(send),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { status: 502, body: { error: "terminal bridge unreachable" } };
  }
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404 || /unknown terminal/i.test(errorBody.error ?? "")) {
      return { status: 404, body: { error: "Unknown terminal" } };
    }
    if (res.status === 409) return { status: 409, body: { error: errorBody.error ?? "Terminal session is stale" } };
    return { status: 502, body: { error: `terminal bridge: HTTP ${res.status}` } };
  }
  return { status: 200, body: snapshotBody((await res.json().catch(() => ({}))) as Record<string, unknown>) };
}

/** A pane's terminal label, if the desktop bridge knows one. */
export async function paneLabel(
  access: TerminalBridgeAccess | null,
  botId: string,
  paneId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!access) return null;
  try {
    const res = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal`, {
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { panes?: Array<{ sessionId?: string; label?: string | null }> };
    return body.panes?.find((pane) => pane.sessionId === paneId)?.label ?? null;
  } catch {
    return null;
  }
}

export async function raisePaneAttention(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId: string,
  kind?: "report" | "auto",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!access) return;
  try {
    // The kind lets the pane's stall watch tell a final report from a passing note.
    await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/attention`, {
      method: "POST",
      headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, kind }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {}
}
