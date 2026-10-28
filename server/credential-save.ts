import { z } from "zod";

import { credentialConfigPatch, isCredentialTargetId, isCustomCredentialId } from "../shared/credential-request.ts";
import { parseConfigPatch } from "./config.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

const inputSchema = z.object({
  target: z.string().refine((id) => isCredentialTargetId(id) || isCustomCredentialId(id) || id === "composioApiKey" || id === "openaiCompatKey"),
  value: z.string().trim().max(8_192),
});
const confirmationSchema = z.object({ saved: z.literal(true) });
const rejectionSchema = z.object({ error: z.literal("credential-rejected") });

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
    } else if (isCustomCredentialId(target)) {
      const patch = parseConfigPatch({ customKeys: { [target.slice(7)]: value ? JSON.parse(value) : null } });
      if (value && !patch.customKeys?.[target.slice(7)]?.key.trim()) throw new Error("invalid-credential");
    } else {
      parseConfigPatch(target === "composioApiKey" ? { composio: { apiKey: value } } : { openaiCompat: { key: value } });
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
    const body = await response.json();
    if (response.status === 400 && rejectionSchema.safeParse(body).success) {
      return { status: 400, body: { error: "credential-rejected" } };
    }
    if (!response.ok || !confirmationSchema.safeParse(body).success) {
      return { status: 503, body: { error: "credential-save-failed" } };
    }
    return { status: 200, body: { saved: true } };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { status: 503, body: { error: "credential-save-timeout" } };
    }
    return { status: 503, body: { error: "desktop-unavailable" } };
  }
}
