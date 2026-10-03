import { redactSecretsInText } from "./redact.ts";
import { terminalSnapshotResponse, type TerminalBridgeAccess } from "./terminal-snapshot.ts";

// oxlint-disable-next-line no-control-regex -- pane labels and folders come back from the terminal bridge
const line = (value: string) => value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

/** The chat row for a pane a bot spawned, read back from the bridge so it names a real pane. Display only, never model input. */
export async function launchNoteText(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  // No id reads the main terminal, which no spawn opened.
  if (!sessionId) return null;
  const snapshot = await terminalSnapshotResponse(access, botId, sessionId, fetchImpl);
  if (snapshot.status !== 200) return null;
  const label = line(String(snapshot.body.label ?? "")) || "pane";
  const text = [
    `Launched ${label}`,
    `Label: ${label}`,
    `Working folder: ${line(String(snapshot.body.cwd ?? "")) || "unknown"}`,
    `Session: ${line(String(snapshot.body.sessionId ?? "")) || line(sessionId)}`,
  ].join("\n");
  return redactSecretsInText(text);
}
