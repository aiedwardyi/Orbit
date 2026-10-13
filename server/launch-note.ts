import { z } from "zod";
import { latestPaneRun, samePaneRun, workerRuns, type WorkerRun } from "../src/lib/worker-runs.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Store } from "./store.ts";
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

export function submittedResumeText(text: string, submittedAt: number): string {
  return `${text}\nSubmitted: ${submittedAt}`;
}

// Senders count ms since their Enter write began, so a phone's clock never matters.
export const submittedAgo = z.number().int().min(0).max(60_000).catch(0);

/** A report after the Enter write already answers the follow-up. */
export function reportedSince(run: WorkerRun | undefined, submittedAt: number): boolean {
  return run?.notes.some((note) => note.at > submittedAt) === true;
}

type LaunchCommit = {
  access: TerminalBridgeAccess | null;
  botId: string;
  threadId: string;
  activePath: Store["activePath"];
  appendMessage: (threadId: string, text: string) => { id: string };
  submittedAgo?: number;
};

/** A resumed row is skipped when the pane's run changed during the snapshot. */
export async function commitLaunchNote(
  input: LaunchCommit,
  sessionId: string,
  resumed: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<{ error: "Unknown terminal" | "main terminal" } | { skipped: true } | { messageId: string }> {
  const submittedAt = Date.now() - (input.submittedAgo ?? 0);
  const reads = () => latestPaneRun(workerRuns(input.activePath(input.threadId)), sessionId);
  const settled = resumed ? reads() : undefined;
  const note = await launchNoteFor(input.access, input.botId, sessionId, resumed, fetchImpl);
  if ("error" in note) return note;
  if (resumed && (!samePaneRun(settled, reads()) || reportedSince(settled, submittedAt))) return { skipped: true };
  const message = input.appendMessage(input.threadId, resumed ? submittedResumeText(note.text, submittedAt) : note.text);
  return { messageId: message.id };
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
