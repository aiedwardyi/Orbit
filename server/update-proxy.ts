import { z } from "zod";
import { updateGrant } from "./terminal-grant.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

export type UpdateAction = "state" | "check" | "download" | "install";

const updateStateMessageSchema = z.object({
  type: z.literal("openmausbot:update-state"),
  state: z.object({ status: z.string() }).passthrough(),
});

/** The desktop updater, proxied for clients without the Electron preload (remote browsers). */
export async function updateBridgeResponse(
  access: TerminalBridgeAccess | null,
  action: UpdateAction,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!access) return { status: 200, body: { status: "unavailable" } };
  let res: Response;
  try {
    res = await fetchImpl(`${access.url}/v1/update/${action}`, {
      method: action === "state" ? "GET" : "POST",
      headers: { authorization: `Bearer ${updateGrant(access.token)}` },
      signal: AbortSignal.timeout(action === "check" ? 60_000 : 5_000),
    });
  } catch {
    return { status: 502, body: { error: "update bridge unreachable" } };
  }
  if (res.status === 404) return { status: 200, body: { status: "unavailable" } };
  if (!res.ok) return { status: 502, body: { error: `update bridge: HTTP ${res.status}` } };
  return { status: 200, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Updater state pushed over Electron's private parent port, or null for any other message. */
export function updateStateFromMessage(message: unknown): Record<string, unknown> | null {
  const parsed = updateStateMessageSchema.safeParse(message);
  return parsed.success ? parsed.data.state : null;
}
