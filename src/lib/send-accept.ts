// Same-tick chrome after composer accepts a send. Thinking / busy / Sends-next
// must not wait for POST or the SSE busy patch: startTurn still runs
// prepareModelContext on the request path before the server flips busy.
import { showWorkingDots } from "./turn-tail";
import { pendingSteerEntries } from "./composer-busy";
import type { Message } from "@/state/store";

export type AcceptedSendKind = "thinking" | "sends-next";

export type AcceptedSend = {
  sendId: string;
  kind: AcceptedSendKind;
  text: string;
};

export type AcceptedSends = Record<string, AcceptedSend[]>;

export function acceptedSendPaint(input: { alreadyBusy: boolean }): { kind: AcceptedSendKind } {
  return { kind: input.alreadyBusy ? "sends-next" : "thinking" };
}

export function hasAcceptedThinking(accepted?: readonly AcceptedSend[]): boolean {
  return Boolean(accepted?.some((entry) => entry.kind === "thinking"));
}

export function composerIsBusy(serverBusy: boolean, accepted?: readonly AcceptedSend[]): boolean {
  return serverBusy || hasAcceptedThinking(accepted);
}

export function turnPresenceWaiting(input: {
  busy?: boolean;
  activity?: string;
  lastMessage?: Message;
  speakerBotId?: string;
  accepted?: readonly AcceptedSend[];
}): boolean {
  if (input.activity === "waiting-on-you") return false;
  if (hasAcceptedThinking(input.accepted)) return true;
  return showWorkingDots(Boolean(input.busy), undefined, input.lastMessage, input.speakerBotId);
}

export function rememberAcceptedSend(
  accepted: AcceptedSends,
  threadId: string,
  send: AcceptedSend,
): AcceptedSends {
  if (!threadId || !send.sendId) return accepted;
  const prev = accepted[threadId] ?? [];
  if (prev.some((entry) => entry.sendId === send.sendId)) return accepted;
  return { ...accepted, [threadId]: [...prev, send] };
}

export function forgetAcceptedSend(
  accepted: AcceptedSends,
  threadId: string,
  sendId: string,
): AcceptedSends {
  const prev = accepted[threadId] ?? [];
  const next = prev.filter((entry) => entry.sendId !== sendId);
  if (next.length === prev.length) return accepted;
  const copy = { ...accepted };
  if (next.length) copy[threadId] = next;
  else delete copy[threadId];
  return copy;
}

export function clearAcceptedThinking(accepted: AcceptedSends, threadId: string): AcceptedSends {
  const prev = accepted[threadId] ?? [];
  const next = prev.filter((entry) => entry.kind !== "thinking");
  if (next.length === prev.length) return accepted;
  const copy = { ...accepted };
  if (next.length) copy[threadId] = next;
  else delete copy[threadId];
  return copy;
}

export function applyOptimisticBusy<T extends { threadId: string; busy?: boolean; activity?: string }>(
  bots: T[],
  accepted: AcceptedSends,
): T[] {
  return bots.map((bot) => {
    if (bot.busy || !hasAcceptedThinking(accepted[bot.threadId])) return bot;
    return { ...bot, busy: true, activity: "working" };
  });
}

export function visibleSteerEntries(
  pending: Record<string, Array<{ queueId: string; text: string }>> | undefined,
  threadId: string | undefined,
  accepted?: readonly AcceptedSend[],
): Array<{ queueId: string; text: string }> {
  const confirmed = pendingSteerEntries(pending, threadId);
  const optimistic = (accepted ?? [])
    .filter((entry) => entry.kind === "sends-next" && !confirmed.some((item) => item.queueId === entry.sendId))
    .map((entry) => ({ queueId: entry.sendId, text: entry.text }));
  return [...confirmed, ...optimistic];
}
