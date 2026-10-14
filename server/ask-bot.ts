// ask_bot's wait on a peer turn. A peer still working past the limit is not
// stopped, so its reply is adopted as a delegation the caller collects with
// wait_delegation instead of paying for the same answer again.

import type { RuntimeEvent } from "./contracts.ts";
import { peerAnswer } from "./peer-takeover.ts";
import type { TurnReplyStep } from "./turn-reply.ts";

export const ASK_BOT_TIMEOUT_MS = Math.max(Number(process.env.OMB_ASK_BOT_TIMEOUT_MS) || 4 * 60_000, 50);

const askLimit = () => {
  const minutes = ASK_BOT_TIMEOUT_MS / 60_000;
  return Number.isInteger(minutes) ? `${minutes} min` : `${Math.round(ASK_BOT_TIMEOUT_MS / 1000)} s`;
};

/** The model reads the id from the text too, so an older proxy still shows it. */
export const askTimeoutText = (botName: string, taskId: string) =>
  `@${botName} is still working (over ${askLimit()}). Task id: ${taskId}. Collect the reply with wait_delegation; do not ask again.`;

export interface AskReply {
  text: string;
  replied: boolean;
  /** Set when the peer outlived the wait and its reply became this delegation. */
  taskId?: string;
}

export function waitForPeerReply(peer: {
  threadId: string;
  botName: string;
  userName: () => string;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  fold: (event: RuntimeEvent) => TurnReplyStep;
  start: () => Promise<void>;
  /** Adopt the still-running turn; its task id, or undefined when it already ended. */
  adopt: () => string | undefined;
}): Promise<AskReply> {
  return new Promise((resolve) => {
    let taskId: string | undefined;
    const answer = peerAnswer(peer.threadId, peer.botName, peer.userName, (text, replied) => {
      clearTimeout(timer);
      unsub();
      resolve(taskId ? { text: askTimeoutText(peer.botName, taskId), replied: false, taskId } : { text, replied });
    });
    const unsub = peer.subscribe((event) => {
      if (event.threadId !== peer.threadId) return;
      const step = peer.fold(event);
      if (step === "completed") answer.end("(the bot finished without a text reply)");
      else if (step) answer.add(step.text);
    });
    const timer = setTimeout(() => {
      taskId = peer.adopt();
      answer.end("(timed out waiting for the bot to reply)", false);
    }, ASK_BOT_TIMEOUT_MS);
    peer.start().catch((err) =>
      answer.end(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`, false),
    );
  });
}
