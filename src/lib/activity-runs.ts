// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";

export type TranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

/** Default-off hides named tool pills, success or fail: the bot usually
 * retries past a miss. Bot⇄bot chips, `error:` turn failures, and
 * memory.save stay. */
export function activityVisibleInChat(message: Message, showToolCalls: boolean): boolean {
  const tool = message.tool;
  return Boolean(
    message.kind === "activity" &&
      tool &&
      (showToolCalls ||
        message.comm ||
        tool.name.startsWith("error:") ||
        tool.name === "memory.save"),
  );
}

/** A named tool, running or settled. A running step joins the run so it
 * settles in place; the fold's header carries its spinner. Turn-level
 * `error:` chips and memory-save stay out — those are not a work run. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm) return false;
  if (tool.name.startsWith("error:") || tool.name === "memory.save") return false;
  return true;
}

/** A folded run shows only when tool calls are on, failures included. */
export function activityRunVisible(_messages: Message[], showToolCalls: boolean): boolean {
  return showToolCalls;
}

export function groupActivityRuns(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** The one line a folded run has to earn its place with: how much work it
 * was and how many files it touched. Status is the icon beside it. */
export function describeRun(messages: Message[]): string {
  const edited = new Set<string>();
  for (const message of messages) {
    const tool = message.tool;
    // the summary leads with the path; "+N -M" trails it
    if (tool && EDIT_TOOLS.has(tool.name) && tool.summary) edited.add(tool.summary.replace(/ \+\d+( -\d+)?$/, ""));
  }
  const files = edited.size ? ` · ${edited.size} ${edited.size === 1 ? "file" : "files"} edited` : "";
  return `${messages.length} steps${files}`;
}
