import { z } from "zod";
import { latestPaneRun, workerRuns } from "../src/lib/worker-runs.ts";
import { launchNoteFor } from "./launch-note.ts";
import type { requestCredentials } from "./phone-auth.ts";
import { apiRequestAuthorized } from "./remote-access.ts";
import type { Store } from "./store.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

type TerminalResumeContext = {
  store: Pick<Store, "bot" | "activePath" | "appendMessage">;
  access: TerminalBridgeAccess | null;
  credentials: ReturnType<typeof requestCredentials>;
  cookie?: string;
};
type TerminalResumeResponse = {
  status: number;
  body: { resumed: boolean; messageId?: string } | { error: string };
};
const resumeRequest = z.object({ sessionId: z.string().min(1).max(128), afterMessageId: z.string().min(1).max(128).optional() });

function latestRun(store: TerminalResumeContext["store"], threadId: string, sessionId: string) {
  return latestPaneRun(workerRuns(store.activePath(threadId)), sessionId);
}

export async function terminalResumeResponse(
  context: TerminalResumeContext,
  botId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- HTTP bodies are parsed at this boundary.
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<TerminalResumeResponse> {
  const path = `/api/bots/${encodeURIComponent(botId)}/terminal/resume`;
  const { credentials, store } = context;
  if (!credentials.phoneSession && !apiRequestAuthorized(credentials.bearerOk, context.cookie, credentials.remoteKey, path)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const bot = store.bot(botId);
  if (!bot) return { status: 404, body: { error: "no such bot" } };
  const parsed = resumeRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "sessionId is required" } };
  const { sessionId } = parsed.data;
  const threadId = bot.threadId;
  const settled = latestRun(store, threadId, sessionId);
  const note = await launchNoteFor(context.access, botId, sessionId, true, fetchImpl);
  if ("error" in note) {
    if (note.error === "main terminal") return { status: 200, body: { resumed: false } };
    return { status: 404, body: { error: "Unknown terminal" } };
  }
  if (!settled || settled.state === "working" || store.bot(botId)?.threadId !== threadId) {
    return { status: 200, body: { resumed: false } };
  }
  if (parsed.data.afterMessageId && settled.messageIds.at(-1) !== parsed.data.afterMessageId) {
    return { status: 200, body: { resumed: false } };
  }
  const current = latestRun(store, threadId, sessionId);
  // A report or another resume can arrive while the bridge snapshot is pending.
  if (!current || current.id !== settled.id || current.messageIds.at(-1) !== settled.messageIds.at(-1) || current.latest.at !== settled.latest.at || current.latest.index !== settled.latest.index) {
    return { status: 200, body: { resumed: false } };
  }
  const message = store.appendMessage(threadId, { role: "bot", kind: "launch", text: note.text });
  return { status: 201, body: { resumed: true, messageId: message.id } };
}
