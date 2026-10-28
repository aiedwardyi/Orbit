import { z } from "zod";

import { credentialConfigPatch, isCredentialTargetId, isCustomCredentialId } from "../shared/credential-request.ts";
import { parseConfigPatch } from "./config.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

const inputSchema = z.object({
  target: z.string().refine((id) => isCredentialTargetId(id) || isCustomCredentialId(id)),
  value: z.string().trim().min(1).max(8_192),
});
const confirmationSchema = z.object({ saved: z.literal(true) });

export async function credentialSaveResponse(
  access: TerminalBridgeAccess | null,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: { saved: true } | { error: string } }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "invalid-credential" } };
  const { target, value } = parsed.data;
  try {
    if (isCredentialTargetId(target)) {
      parseConfigPatch(credentialConfigPatch(target, value));
    } else {
      const patch = parseConfigPatch({ customKeys: { [target.slice(7)]: JSON.parse(value) } });
      if (!patch.customKeys?.[target.slice(7)]?.key.trim()) throw new Error("invalid-credential");
    }
  } catch {
    return { status: 400, body: { error: "invalid-credential" } };
  }
  if (!access) return { status: 503, body: { error: "desktop-unavailable" } };
  try {
    const response = await fetchImpl(`${access.url}/v1/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ target, value }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !confirmationSchema.safeParse(await response.json()).success) {
      return { status: 503, body: { error: "credential-save-failed" } };
    }
    return { status: 200, body: { saved: true } };
  } catch {
    return { status: 503, body: { error: "desktop-unavailable" } };
  }
}
