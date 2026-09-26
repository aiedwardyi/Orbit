import { z } from "zod";
import { terminalReadGrant, terminalSendGrant } from "./terminal-grant.ts";

export type TerminalBridgeAccess = { url: string; token: string };

const SNAPSHOT_FIELDS = ["screenText", "screenRuns", "recentText", "state", "sessionId", "generation", "cwd", "exited", "exitCode", "label", "panes"] as const;
export const TERMINAL_SEND_MAX_BYTES = 4 * 1024;
// ESC covers kitty-mode keys like \x1b[99;5u (Ctrl+C); tab and newlines stay allowed.
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const TERMINAL_KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" } as const;
export type TerminalKey = keyof typeof TERMINAL_KEYS;

const terminalSendSchema = z.union([
  z.object({ sessionId: z.string().min(1), generation: z.number().int(), text: z.string(), paste: z.boolean().optional() }),
  z.object({ sessionId: z.string().min(1), generation: z.number().int(), key: z.enum(["up", "down", "enter", "esc"]) }),
]);

function snapshotBody(snapshot: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of SNAPSHOT_FIELDS) if (snapshot[key] !== undefined) body[key] = snapshot[key];
  return body;
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
