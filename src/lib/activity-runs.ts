// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { MessageKey, Translate } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { termVerb } from "@/lib/terminal-skin";

export type ApprovalLabel = "auto" | "always" | "review";

export type ServerNotice =
  | { kind: "approval"; label: ApprovalLabel; tool: string; summary: string }
  | { kind: "line" };

export interface LinkedApproval {
  message: Message;
  label: ApprovalLabel;
  tool: string;
  summary: string;
}

export type TranscriptItem =
  | { kind: "message"; message: Message; notices?: LinkedApproval[] }
  | { kind: "run"; id: string; messages: Message[]; notices?: Map<string, LinkedApproval[]> };

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

const ALWAYS_APPROVAL = /^auto-approved (.+?) \(always allowed\): ([\s\S]*)$/;
const AUTO_APPROVAL = /^auto-approved ([^:]+): ([\s\S]*)$/;
const REVIEW_APPROVAL = /^review approved ([^:]+): ([\s\S]*)$/;

function toolFromAllowKey(key: string): string {
  const rest = key.startsWith("local-computer:") ? key.slice("local-computer:".length) : key;
  const cut = rest.indexOf(":");
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** Server chips that are not tool calls. `error:` stays a turn failure. */
export function classifyServerNotice(name: string): ServerNotice | null {
  if (name.startsWith("error:")) return null;
  const always = ALWAYS_APPROVAL.exec(name);
  if (always) return { kind: "approval", label: "always", tool: toolFromAllowKey(always[1]), summary: always[2] };
  const auto = AUTO_APPROVAL.exec(name);
  if (auto) return { kind: "approval", label: "auto", tool: auto[1], summary: auto[2] };
  const review = REVIEW_APPROVAL.exec(name);
  if (review) return { kind: "approval", label: "review", tool: review[1], summary: review[2] };
  if (
    /^@.+ is waiting on your approval$/.test(name) ||
    /^retrying \u2014 attempt \d+\/\d+ in \d+s \u2014 /.test(name) ||
    /^Same call repeated \d+× \u2014 /.test(name) ||
    name.endsWith(" is still stopping \u2014 this message was not dispatched")
  ) return { kind: "line" };
  return null;
}

interface ServerLine {
  re: RegExp;
  pick: (m: RegExpExecArray) => [MessageKey, Record<string, string | number>];
  /** fixed English the server must keep writing, in `file`; the drift guard scans for it */
  file: "comms-visibility.ts" | "delegations.ts" | "index.ts";
  needles: string[];
}

/** Bot handoff lines the server stores in English. Free text (`why`, `reason`) goes last so t() never rescans it. */
export const SERVER_LINES: ServerLine[] = [
  { re: /^Message to @(.+)$/, pick: (m) => ["chat.messageToBot", { name: m[1] }], file: "comms-visibility.ts", needles: ["Message to @"] },
  { re: /^Message from @(.+)$/, pick: (m) => ["chat.messageFromBot", { name: m[1] }], file: "comms-visibility.ts", needles: ["Message from @"] },
  { re: /^Reply from @(.+)$/, pick: (m) => ["chat.replyFromBot", { name: m[1] }], file: "comms-visibility.ts", needles: ["Reply from @"] },
  {
    re: /^Queued for @(.+?), sends when this reply ends(?:: ([\s\S]*))?$/,
    pick: (m) => (m[2] === undefined ? ["chat.delegation.queued", { name: m[1] }] : ["chat.delegation.queuedReason", { name: m[1], reason: m[2] }]),
    file: "delegations.ts",
    needles: ["Queued for @", ", sends when this reply ends"],
  },
  { re: /^delegation failed \u2014 ([\s\S]*)$/, pick: (m) => ["chat.delegation.failed", { why: m[1] }], file: "delegations.ts", needles: ["error: delegation failed \u2014 "] },
  {
    re: /^delegation to @(.+?) could not start \u2014 ([\s\S]*)$/,
    pick: (m) => ["chat.delegation.couldNotStartError", { name: m[1], why: m[2] }],
    file: "index.ts",
    needles: ["error: delegation to @", " could not start \u2014 "],
  },
  {
    re: /^delegation to (.+) failed \u2014 no such bot$/,
    pick: (m) => ["chat.delegation.noSuchBot", { id: m[1] }],
    file: "delegations.ts",
    needles: ["error: delegation to ", " failed \u2014 no such bot"],
  },
  {
    re: /^Delegation to @(.+) dropped - the turn did not finish$/,
    pick: (m) => ["chat.delegation.dropped", { name: m[1] }],
    file: "delegations.ts",
    needles: ["Delegation to @", " dropped - the turn did not finish"],
  },
  {
    re: /^(\d+) queued delegation(s?) dropped \u2014 the turn did not finish$/,
    pick: (m) => [m[2] ? "chat.delegation.droppedMany" : "chat.delegation.droppedOne", { count: m[1] }],
    file: "delegations.ts",
    needles: [" queued delegation", " dropped \u2014 the turn did not finish"],
  },
  {
    re: /^Delegation to @(.+?) waiting \u2014 they're busy \(retry (\d+)\/(\d+) when they finish\)$/,
    pick: (m) => ["chat.delegation.waiting", { name: m[1], attempt: m[2], max: m[3] }],
    file: "delegations.ts",
    needles: [" waiting \u2014 they're busy (retry ", " when they finish)"],
  },
  {
    re: /^Delegation to @(.+?) canceled \u2014 still busy after (\d+) retries$/,
    pick: (m) => ["chat.delegation.canceled", { name: m[1], count: m[2] }],
    file: "delegations.ts",
    needles: [" canceled \u2014 still busy after ", " retries"],
  },
  { re: /^Delegation to @(.+) denied by user$/, pick: (m) => ["chat.delegation.denied", { name: m[1] }], file: "delegations.ts", needles: [" denied by user"] },
  { re: /^Delivered to @(.+)$/, pick: (m) => ["chat.delegation.delivered", { name: m[1] }], file: "delegations.ts", needles: ["Delivered to @"] },
  { re: /^@(.+) replied$/, pick: (m) => ["chat.delegation.replied", { name: m[1] }], file: "delegations.ts", needles: ["@${target.name} replied"] },
  {
    re: /^(.+?) answered (.+) in its own chat instead$/,
    pick: (m) => ["chat.delegation.answeredElsewhere", { name: m[1], who: m[2] }],
    file: "delegations.ts",
    needles: [" answered ", " in its own chat instead"],
  },
  { re: /^Delegated turn did not finish$/, pick: () => ["chat.delegation.turnDidNotFinish", {}], file: "delegations.ts", needles: ["Delegated turn did not finish"] },
  { re: /^Delegated turn completed$/, pick: () => ["chat.delegation.turnCompleted", {}], file: "delegations.ts", needles: ["Delegated turn completed"] },
  { re: /^Delegated turn stalled and was stopped$/, pick: () => ["chat.delegation.turnStalled", {}], file: "index.ts", needles: ["Delegated turn stalled and was stopped"] },
  {
    re: /^Delegated turn could not start \u2014 ([\s\S]*)$/,
    pick: (m) => ["chat.delegation.turnCouldNotStart", { why: m[1] }],
    file: "index.ts",
    needles: ["Delegated turn could not start \u2014 "],
  },
];

/** A server handoff line in the app's language; anything unrecognised comes back as written. Display only. */
export function localizeServerLine(name: string, t: Translate): string {
  const prefix = name.startsWith("error: ") ? "error: " : "";
  const body = name.slice(prefix.length);
  for (const line of SERVER_LINES) {
    const m = line.re.exec(body);
    if (m) {
      const [key, vars] = line.pick(m);
      return prefix + t(key, vars);
    }
  }
  return name;
}

export function isApprovalNotice(message: Message): boolean {
  return classifyServerNotice(message.tool?.name ?? "")?.kind === "approval";
}

function isWorkStep(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool || message.comm) return false;
  if (classifyServerNotice(tool.name) || tool.name.startsWith("error:") || tool.name === "memory.save") return false;
  return true;
}

function sameBot(a: Message, b: Message): boolean {
  return (a.from?.botId ?? "") === (b.from?.botId ?? "");
}

function sameTool(step: Message, tool: string): boolean {
  const name = step.tool?.name ?? "";
  const verb = step.tool?.verb ?? "";
  const names = new Set<string>();
  if (name) { names.add(name); names.add(termVerb(name)); }
  if (verb) { names.add(verb); names.add(termVerb(verb)); }
  return names.has(tool) || names.has(termVerb(tool));
}

function linkApprovals(messages: Message[]) {
  const byStep = new Map<string, LinkedApproval[]>();
  const consumed = new Set<string>();
  let pending: Message[] = [];
  for (const message of messages) {
    // an approval belongs to a step from its own turn, never an older one
    if (message.role === "user") pending = [];
    const notice = message.kind === "activity" ? classifyServerNotice(message.tool?.name ?? "") : null;
    if (notice?.kind === "approval") {
      let index = -1;
      let score = 0;
      for (let i = 0; i < pending.length; i++) {
        const step = pending[i];
        if (!sameBot(step, message) || !sameTool(step, notice.tool)) continue;
        const have = step.tool?.summary ?? "";
        // exact summary, then a truncated prefix, then any same-tool step; ties go to the earliest
        const rank = have === notice.summary ? 3 : notice.summary && have && (have.startsWith(notice.summary) || notice.summary.startsWith(have)) ? 2 : 1;
        if (rank > score) {
          score = rank;
          index = i;
        }
      }
      if (index >= 0) {
        const step = pending.splice(index, 1)[0];
        const list = byStep.get(step.id) ?? [];
        list.push({ message, label: notice.label, tool: notice.tool, summary: notice.summary });
        byStep.set(step.id, list);
        consumed.add(message.id);
      }
      continue;
    }
    if (isWorkStep(message)) pending.push(message);
  }
  return { byStep, consumed };
}

function messageItem(message: Message, notices: LinkedApproval[] | undefined): TranscriptItem {
  if (!notices?.length) return { kind: "message", message };
  return { kind: "message", message, notices };
}

function noticesFor(steps: Message[], byStep: Map<string, LinkedApproval[]>): Map<string, LinkedApproval[]> | undefined {
  const map = new Map<string, LinkedApproval[]>();
  for (const step of steps) {
    const list = byStep.get(step.id);
    if (list?.length) map.set(step.id, list);
  }
  return map.size ? map : undefined;
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

const SEARCH_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** `terminal` folds only Read/Grep/Glob stretches, even a single read, the
 * way Claude Code does; every other step stays unfolded. */
export function groupActivityRuns(messages: Message[], terminal = false): TranscriptItem[] {
  const linked = linkApprovals(messages);
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    const notices = noticesFor(run, linked.byStep);
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > (terminal ? 0 : 1)) {
      const id = `run:${run[0].id}`;
      items.push(notices ? { kind: "run", id, messages: run, notices } : { kind: "run", id, messages: run });
    } else for (const message of run) items.push(messageItem(message, linked.byStep.get(message.id)));
    run = [];
  };
  for (const message of messages) {
    if (linked.consumed.has(message.id)) continue;
    if (foldable(message) && (!terminal || SEARCH_TOOLS.has(termVerb(message.tool?.verb ?? message.tool?.name ?? "")))) {
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
    items.push(messageItem(message, linked.byStep.get(message.id)));
  }
  flush();
  return items;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** The one line a folded run has to earn its place with: how much work it
 * was and how many files it touched. Status is the icon beside it. */
export function describeRun(messages: Message[]): string {
  const steps = messages.filter((message) => !isApprovalNotice(message));
  const edited = new Set<string>();
  for (const message of steps) {
    const tool = message.tool;
    // the summary leads with the path; "+N -M" trails it
    if (tool && EDIT_TOOLS.has(tool.name) && tool.summary) edited.add(tool.summary.replace(/ \+\d+( -\d+)?$/, ""));
  }
  const files = edited.size ? ` · ${edited.size} ${edited.size === 1 ? "file" : "files"} edited` : "";
  return `${steps.length} steps${files}`;
}

/** Default skins drop approval rows from an opened run. A find hit still shows. */
export function shownRunStep(
  step: Message,
  options: { terminal: boolean; showActivities: boolean; findId: string | null; notices?: LinkedApproval[] },
): boolean {
  const found = step.id === options.findId || (options.notices?.some((notice) => notice.message.id === options.findId) ?? false);
  if (!options.terminal && isApprovalNotice(step) && step.id !== options.findId) return false;
  return options.showActivities || step.tool?.ok === false || found;
}

export function itemMatchesFind(item: TranscriptItem, findId: string | null): boolean {
  if (!findId) return false;
  if (item.kind === "run") {
    if (item.messages.some((message) => message.id === findId)) return true;
    for (const list of item.notices?.values() ?? []) {
      if (list.some((notice) => notice.message.id === findId)) return true;
    }
    return false;
  }
  return item.message.id === findId || (item.notices?.some((notice) => notice.message.id === findId) ?? false);
}

/** Claude Code's one line for a stretch of reads and searches. */
export function describeSearch(messages: Message[]): string {
  if (!messages.length) return "Searched";
  const patterns = messages.filter((message) => termVerb(message.tool?.verb ?? message.tool?.name ?? "") !== "Read").length;
  const files = messages.length - patterns;
  return [
    patterns && `Searched for ${patterns} ${patterns === 1 ? "pattern" : "patterns"}`,
    files && `${patterns ? "read" : "Read"} ${files} ${files === 1 ? "file" : "files"}`,
  ]
    .filter(Boolean)
    .join(", ");
}
