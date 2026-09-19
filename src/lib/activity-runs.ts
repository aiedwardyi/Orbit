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

/** A finished named tool, success or fail. Running steps stay out so live
 * progress is never hidden behind a fold. Turn-level `error:` chips and
 * memory-save stay out too — those are not a work run. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm) return false;
  if (tool.ok !== true && tool.ok !== false) return false;
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

const MAX_NAMES = 3;

/** The one line a folded run has to earn its place with: how much work it
 * was and which tools did it. A failure count stays in the summary as muted
 * text, not a reason to go red. */
export function describeRun(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.tool?.name ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` +${names.length - MAX_NAMES} more` : "";
  const failed = messages.filter((message) => message.tool?.ok === false).length;
  const failBit = failed ? ` · ${failed} failed` : "";
  if (counts.size === 1) {
    const [name, count] = [...counts][0]!;
    return `${count} ${name}${failBit}`;
  }
  return `${messages.length} steps · ${shown}${rest}${failBit}`;
}
