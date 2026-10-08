// Trades an operator invite for a ticket (design section 4). The invite is
// sent once and never stored; keys and the ticket never leave this module
// except to the relay and the private data directory.

import { sign } from "node:crypto";
import { z } from "zod";

import { INVITE_PREFIX } from "../../shared/relay-protocol.ts";
import { httpsRequest, type HttpsDeps } from "./https.ts";
import type { PhoneRelayEnrollOptions } from "./index.ts";
import { relayHostFor, relayMode } from "./mode.ts";
import { loadOrCreateIdentity, ticketProblem, writeTicket } from "./store.ts";

export const ENROLL_CONTEXT = "wink-relay-enroll/1";
export const ENROLL_TIMEOUT_MS = 15_000;
export const ENROLL_MAX_BYTES = 32 * 1024;
const MAX_INVITE_LENGTH = 16 * 1024;

const enrollResponseSchema = z.object({ ticket: z.string().min(1).max(16 * 1024) });
const enrollErrorSchema = z.object({ error: z.string().regex(/^[a-z0-9-]{1,64}$/) });

export interface EnrollDeps {
  https?: HttpsDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Bytes the enroll signature covers. */
export function enrollPayload(invite: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([ENROLL_CONTEXT, invite, pk]), "utf8");
}

function parseJsonText(text: string): z.core.util.JSONType | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function enrollWith(options: PhoneRelayEnrollOptions, deps: EnrollDeps = {}): Promise<void> {
  const mode = relayMode(options.config, deps.env ?? process.env);
  if (mode.kind === "off") throw new Error("phone relay is off");
  if (mode.kind === "invalid") throw new Error(mode.reason);
  const invite = options.invite.trim();
  if (!invite.startsWith(`${INVITE_PREFIX}.`) || invite.length > MAX_INVITE_LENGTH) throw new Error("invalid invite");

  const identity = loadOrCreateIdentity(options.dataDir);
  const sig = sign(null, enrollPayload(invite, identity.pk), identity.privateKey).toString("base64url");
  const res = await httpsRequest(
    {
      method: "POST",
      url: `https://${relayHostFor(mode.base)}/v1/enroll`,
      body: JSON.stringify({ invite, pk: identity.pk, sig }),
      timeoutMs: ENROLL_TIMEOUT_MS,
      maxBytes: ENROLL_MAX_BYTES,
    },
    deps.https,
  );
  const body = parseJsonText(res.body.toString("utf8"));
  if (res.status !== 200) {
    const code = enrollErrorSchema.safeParse(body);
    throw new Error(`relay refused enrollment (${res.status}${code.success ? ` ${code.data.error}` : ""})`);
  }
  const parsed = enrollResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("relay sent an unreadable enrollment answer");
  const problem = ticketProblem(parsed.data.ticket, identity, (deps.now ?? Date.now)());
  if (problem) throw new Error(`relay sent an unusable ticket: ${problem}`);
  writeTicket(options.dataDir, parsed.data.ticket);
}
