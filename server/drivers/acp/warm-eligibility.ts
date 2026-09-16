/**
 * SPEED-4 warm ACP session eligibility fingerprint.
 * Reuse only when bot/thread identity, provider identity, cwd, tools/MCP,
 * approval scope, model, and effort still match. Prompt/system text is NOT
 * part of the fingerprint: each turn re-composes session/prompt via
 * buildPromptText. A missing or different resumeCursor forces cold
 * session/new or session/load (compaction/rewind) instead of reviving the
 * warm child.
 */
export type WarmEligibilityInput = {
  threadId: string;
  cwd: string;
  sessionCwd: string;
  model?: string;
  effort?: string;
  approval?: string;
  fullAuto: boolean;
  /** Auth/account fingerprint from support.warmSessionIdentity. */
  identity: string;
  cli: string;
  /** Stable serialization of spawn argv after the binary. */
  argsKey: string;
  /** Stable serialization of MCP / integration endpoints. */
  toolsKey: string;
};

export type SendTurnIntegrations = {
  composio?: { command: string; args?: string[]; env?: Record<string, string> };
  computer?: { boxId?: string };
  localComputer?: { command: string; args?: string[]; scope?: string };
  agents?: { command: string; args?: string[] };
  browser?: unknown;
};

export function warmToolsKey(integrations: SendTurnIntegrations | undefined): string {
  if (!integrations) return "";
  const parts: string[] = [];
  if (integrations.composio) {
    parts.push(`composio:${integrations.composio.command}|${(integrations.composio.args ?? []).join(" ")}`);
  }
  if (integrations.computer) {
    parts.push(`computer:${integrations.computer.boxId ?? ""}`);
  }
  if (integrations.localComputer) {
    parts.push(
      `local:${integrations.localComputer.command}|${(integrations.localComputer.args ?? []).join(" ")}|${integrations.localComputer.scope ?? ""}`,
    );
  }
  if (integrations.agents) {
    parts.push(`agents:${integrations.agents.command}|${(integrations.agents.args ?? []).join(" ")}`);
  }
  if (integrations.browser) {
    parts.push("browser:1");
  }
  return parts.sort().join(";");
}

export function warmFingerprint(input: WarmEligibilityInput): string {
  return [
    input.identity,
    input.threadId,
    input.cli,
    input.argsKey,
    input.cwd,
    input.sessionCwd,
    input.model ?? "",
    input.effort ?? "",
    input.approval ?? "",
    input.fullAuto ? "1" : "0",
    input.toolsKey,
  ].join("\u001f");
}

/**
 * True when a warm idle session may be reused for this turn.
 * - Matching resumeCursor (the live session id) is required: Orbit stores that
 *   cursor after session.started, and follow-ups must ask for the same session.
 * - Missing resumeCursor (compaction) or a different cursor (rewind / other
 *   session) always forces the cold path.
 */
export function canReuseWarmSession(
  stored: WarmEligibilityInput,
  next: WarmEligibilityInput,
  warmSessionId: string,
  resumeCursor: unknown,
): boolean {
  if (typeof resumeCursor !== "string" || resumeCursor.length === 0) return false;
  if (resumeCursor !== warmSessionId) return false;
  return warmFingerprint(stored) === warmFingerprint(next);
}
