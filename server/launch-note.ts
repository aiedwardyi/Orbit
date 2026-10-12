import { z } from "zod";
import { redactSecretsInText } from "./redact.ts";
import { terminalSnapshotResponse, type TerminalBridgeAccess } from "./terminal-snapshot.ts";

// oxlint-disable-next-line no-control-regex -- pane labels and folders come back from the terminal bridge
const line = (value: string) => value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

export type LaunchNote = { text: string } | { error: "Unknown terminal" | "main terminal" };

const paneList = z.array(z.object({ sessionId: z.string(), main: z.boolean().optional() }));

function isMainSession(sessionId: string, snapshotSessionId: string, panes: z.infer<typeof paneList>): boolean {
  return panes.some((pane) => pane.main === true && (pane.sessionId === sessionId || pane.sessionId === snapshotSessionId));
}

/** The chat row for a pane a bot spawned, read back from the bridge so it names a real pane. Display only, never model input. */
export async function launchNoteFor(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId: string,
  resumed = false,
  fetchImpl: typeof fetch = fetch,
): Promise<LaunchNote> {
  // No id reads the main terminal, which no spawn opened.
  if (!sessionId) return { error: "Unknown terminal" };
  const snapshot = await terminalSnapshotResponse(access, botId, sessionId, fetchImpl);
  if (snapshot.status !== 200) return { error: "Unknown terminal" };
  const panes = paneList.safeParse(snapshot.body.panes);
  const snapshotSessionId = z.string().min(1).safeParse(snapshot.body.sessionId);
  if (resumed && panes.success && isMainSession(sessionId, snapshotSessionId.success ? snapshotSessionId.data : sessionId, panes.data)) {
    return { error: "main terminal" };
  }
  const label = line(String(snapshot.body.label ?? "")) || "pane";
  const text = [
    `${resumed ? "Resumed" : "Launched"} ${label}`,
    `Label: ${label}`,
    `Working folder: ${line(String(snapshot.body.cwd ?? "")) || "unknown"}`,
    `Session: ${line(String(snapshot.body.sessionId ?? "")) || line(sessionId)}`,
  ].join("\n");
  return { text: redactSecretsInText(text) };
}

export async function launchNoteText(
  access: TerminalBridgeAccess | null,
  botId: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  resumed = false,
): Promise<string | null> {
  const note = await launchNoteFor(access, botId, sessionId, resumed, fetchImpl);
  return "text" in note ? note.text : null;
}
