import { redactSecretsInText } from "./redact.ts";

// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed), a fresh engine (this instance has no session here — the user
// switched the bot's model mid-thread), and a recycled session (Orbit
// compacted the thread, or a pre-compact soak fattened the native CLI
// session with tool payloads). They coincide today but are distinct
// markers on purpose: rewound also invalidates OTHER instances' cursors;
// recycle drops this task's cursors so the next turn injects summary+tail
// (or the still-uncompacted Orbit transcript).
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /**
   * The native provider session must not be resumed: Orbit compacted the
   * thread, or a pre-compact soak fattened the CLI session with tool
   * payloads. CLI `--resume` would re-send that fat history.
   */
  recycled?: boolean;
  /**
   * Why the provider session is being recycled. Compaction keeps the PR 70
   * preamble; a pre-first-compact fat soak uses a distinct session-bound
   * marker so the model is not told a summary exists when it does not.
   * `system`: the system text changed too much for a reminder.
   */
  recycleReason?: "compaction" | "session-fat" | "system";
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
  /** durable harness state, included only at a recovery boundary */
  taskRecord?: TaskRecordContext;
  /** Pre-sized durable state for the selected model window. */
  taskRecordText?: string;
  /** the active transcript exceeded the replay tail */
  contextCapped?: boolean;
  /** the prior process or user stop ended the running turn */
  recovering?: boolean;
  /** the request this turn must answer; the transcript excludes it on a plain send */
  currentRequestText?: string;
}

export interface TaskRecordContext {
  goal: string;
  plan: Array<{ step: string; status: "pending" | "active" | "done" | "skipped" }>;
  completed: Array<{ note: string }>;
  evidence?: Array<{ kind: string; ref: string; note?: string }>;
  artifacts?: Array<{ ref: string; label: string }>;
  blockers: Array<{ note: string }>;
  nextAction: string;
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread may only have an
 * onboarding card, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  model: string;
  lastInstanceId: string | undefined;
  lastModel: string | undefined;
  sessionModelSwitch: "in-session" | "unsupported";
  resumeCursors: Record<string, unknown>;
  resumeCursor?: boolean;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  hasPriorUserTurn?: boolean;
}): boolean {
  const { instanceId, model, lastInstanceId, lastModel, sessionModelSwitch, resumeCursors, transcript } = input;
  if (!(input.hasPriorUserTurn ?? transcript.some((message) => message.role === "user"))) return false;
  if (input.resumeCursor === false) return true;
  if (lastInstanceId !== undefined) {
    if (lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined) return true;
    return sessionModelSwitch === "unsupported" && lastModel !== undefined && lastModel !== model;
  }
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

/**
 * Forever-chat history belongs to Orbit's prepared context once a durable
 * summary exists. Resume-cursor engines (Claude `--resume`, Codex
 * thread/resume, pi `switch_session`, Antigravity `--conversation`, ACP
 * session/load) would otherwise keep growing a provider-side session that
 * ignores that projection.
 *
 * Before the first compact, a long agentic soak can still fatten the
 * native session with full tool payloads while Orbit's own transcript
 * stays cheap (collapsed chips). Recycle on the next user send when the
 * session's own latest prompt passed its budget, for engines that report
 * one. Otherwise when the last turn was tool-heavy, settled tools since the
 * last compact exceed the session budget, or the provider reported native
 * input over half the model window, the same share compaction uses.
 *
 * Stop / crash Continuity still `--resume`s when there is no compaction
 * yet, even if the session is already fat. A rewind already drops resume
 * on its own path.
 */
export const PRE_COMPACT_TOOL_ROUND_LIMIT = 24;
export const PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT = 48;
const NATIVE_SESSION_BUDGET_SHARE = 0.5;
// Well above a fresh session's own first prompt: ~45k of tools and startup
// text plus a replay of up to ~92k.
export const NATIVE_PROMPT_BUDGET_CAP = 250_000;
const NATIVE_PROMPT_GROWTH = 100_000;

export function nativeSessionTokenBudget(contextWindow: number): number {
  return Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.max(1, Math.floor(contextWindow * NATIVE_SESSION_BUDGET_SHARE))
    : 0;
}

/** Half the window, capped: on a 1M window every call would re-read 500k first. */
export function nativePromptBudget(contextWindow: number): number {
  return Math.min(NATIVE_PROMPT_BUDGET_CAP, nativeSessionTokenBudget(contextWindow));
}

/** Prompt sizes an engine reported for one native session. */
export interface NativePrompt {
  /** the resume cursor of that session */
  cursor: unknown;
  /** its first reported call: tools, startup text and any replay */
  first: number;
  /** its latest call */
  last: number;
  /** the window the engine reported, and the model it was reported for */
  window?: { model: string; tokens: number };
}

export interface SessionPrompt {
  first: number;
  last: number;
  contextWindow: number;
}

/** The figures for the session this send would resume, if any describe it. */
export function sessionPromptFor(input: {
  report: NativePrompt | undefined;
  cursor: unknown;
  model: string;
  catalogWindow: number | null;
}): SessionPrompt | undefined {
  const { report } = input;
  if (!report || input.cursor === undefined || report.cursor !== input.cursor) return undefined;
  const contextWindow = (report.window?.model === input.model ? report.window.tokens : null) ?? input.catalogWindow;
  return contextWindow ? { first: report.first, last: report.last, contextWindow } : undefined;
}

// A session must also outgrow its own first prompt, or a replay that alone
// passes a small window's budget would recycle every send.
function sessionPromptOverBudget({ first, last, contextWindow }: SessionPrompt): boolean {
  const budget = nativePromptBudget(contextWindow);
  return budget > 0 && last > budget && last - first >= Math.min(NATIVE_PROMPT_GROWTH, Math.floor(budget / 2));
}

export interface SessionFatMessage {
  id?: string;
  kind?: string;
  role?: string;
  tool?: { ok?: boolean };
}

function isSettledTool(message: SessionFatMessage): boolean {
  return message.kind === "activity" && message.tool?.ok !== undefined;
}

/** Settled tool chips after the previous user line (the last completed soak)
 *  or the recycle watermark, whichever is later. Pane wakes add no user line. */
export function countLastTurnToolRounds(
  messages: readonly SessionFatMessage[],
  excludeIds?: ReadonlySet<string>,
  boundMessageId?: string,
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id && excludeIds?.has(message.id)) continue;
    if (message.kind === "text" && message.role === "user") break;
    if (boundMessageId && message.id === boundMessageId) break;
    if (isSettledTool(message)) count++;
  }
  return count;
}

/** Settled tool chips after the latest compaction marker or recycle
 *  watermark (`boundMessageId`). Without the watermark a front-loaded
 *  soak would keep recycling every later send until Orbit compacted. */
export function countSessionToolRounds(
  messages: readonly SessionFatMessage[],
  excludeIds?: ReadonlySet<string>,
  boundMessageId?: string,
): number {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.kind === "compaction") {
      start = index + 1;
      break;
    }
  }
  if (boundMessageId) {
    const boundIndex = messages.findIndex((message) => message.id === boundMessageId);
    if (boundIndex >= 0) start = Math.max(start, boundIndex + 1);
  }
  let count = 0;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.id && excludeIds?.has(message.id)) continue;
    if (isSettledTool(message)) count++;
  }
  return count;
}

export function shouldRecycleProviderSession(input: {
  compacted: boolean;
  rewound?: boolean;
  recovering?: boolean;
  lastTurnToolRounds?: number;
  sessionToolRounds?: number;
  lastTurnInputTokens?: number;
  nativeTokenBudget?: number;
  /** the session's own prompt sizes; they replace the tool-count rules */
  sessionPrompt?: SessionPrompt;
}): boolean {
  if (input.rewound) return false;
  // Compaction always forces a recycle regardless of recovery state: a
  // recovered session that was then compacted must start fresh.
  if (input.compacted) return true;
  if (input.recovering) return false;
  if (input.sessionPrompt) return sessionPromptOverBudget(input.sessionPrompt);
  if ((input.lastTurnToolRounds ?? 0) >= PRE_COMPACT_TOOL_ROUND_LIMIT) return true;
  if ((input.sessionToolRounds ?? 0) >= PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT) return true;
  const budget = input.nativeTokenBudget ?? 0;
  return budget > 0 && (input.lastTurnInputTokens ?? 0) > budget;
}

/** The session a turn certified: the summary id (null: none) the provider
 * accepted into `cursor` on `instanceId`. */
export interface ResumeSeed {
  instanceId: string;
  cursor: unknown;
  compactionId: string | null;
}

/** A cursor is resumable only once the provider accepted a prompt carrying the
 * thread's current summary into that very session. A session that failed
 * before its prompt, another instance's certification, or a seed that
 * predates the newest summary would otherwise resume without Orbit's context.
 * A grown window replaces the summary with the original history, so the
 * session must have been seeded with that (no summary) instead. Absent seed
 * (tasks from before seeds existed included): replay once. */
export function resumeSessionUnseeded(input: {
  instanceId: string;
  cursor: unknown;
  seed: ResumeSeed | undefined;
  latestCompactionId: string | null;
  expanded?: boolean;
}): boolean {
  if (input.cursor === undefined) return false;
  const { seed } = input;
  if (!seed || seed.instanceId !== input.instanceId || seed.cursor !== input.cursor) return true;
  return seed.compactionId !== (input.expanded ? null : input.latestCompactionId);
}

/** A turn certifies only the session it ran on: the cursor it resumed, or the
 * one its own session.started set, on its own instance. A late session.started
 * from a stopped turn can move the task's cursor underneath a live one. */
export function turnSeedsSession(input: {
  ok: boolean;
  interrupted: boolean;
  promptAccepted?: boolean;
  seed: { instanceId: string; cursor: unknown };
  eventInstanceId?: string;
  currentCursor: unknown;
}): boolean {
  if (!input.promptAccepted && !(input.ok && !input.interrupted)) return false;
  if (input.eventInstanceId !== undefined && input.eventInstanceId !== input.seed.instanceId) return false;
  return input.seed.cursor !== undefined && input.seed.cursor === input.currentCursor;
}

export type TurnSeed<T = ResumeSeed> = T & {
  /** the adapter's id for the dispatch, once sendTurn returned it */
  turnId?: string;
};

/** Thread -> what its running 1:1 turn certifies on completion. Each entry
 * belongs to the dispatch that set it: a stopped dispatch's cleanup or late
 * completion must not drop or consume its replacement's entry. */
export class TurnSeeds<T extends { instanceId: string; cursor: unknown } = ResumeSeed> {
  private readonly byThread = new Map<string, TurnSeed<T>>();

  set(threadId: string, seed: T): TurnSeed<T> {
    const entry: TurnSeed<T> = { ...seed };
    this.byThread.set(threadId, entry);
    return entry;
  }

  get(threadId: string): TurnSeed<T> | undefined {
    return this.byThread.get(threadId);
  }

  /** Drop `entry` only while it is still the thread's current seed. */
  release(threadId: string, entry: TurnSeed<T>): void {
    if (this.byThread.get(threadId) === entry) this.byThread.delete(threadId);
  }

  /** Consume the seed of the turn that completed; another dispatch's stays. */
  take(threadId: string, turnId: string | undefined): TurnSeed<T> | undefined {
    const entry = this.byThread.get(threadId);
    if (!entry || turnId === undefined || entry.turnId !== turnId) return undefined;
    this.byThread.delete(threadId);
    return entry;
  }
}

/** Cap on the changed lines' characters; past it the session recycles instead. */
export const SYSTEM_REMINDER_MAX_CHARS = 12_000;
// Most of Wink's guidance is one long line; split such lines at sentence
// ends so one changed rule does not resend the rest.
const SYSTEM_LINE_SPLIT_CHARS = 2_000;
const SYSTEM_REMINDER_HEADER =
  "[Wink instructions update - your system prompt changed after this session started. Removed lines no longer apply; added lines are current and win over anything older.]";

function systemLines(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trimEnd();
      return trimmed.length > SYSTEM_LINE_SPLIT_CHARS ? trimmed.split(/(?<=[.!?])\s+/) : [trimmed];
    })
    .filter((line) => line.trim());
}

/** Lines of `from` that `other` does not also hold, in `from`'s order. */
function linesOnlyIn(from: string[], other: string[]): string[] {
  const left = new Map<string, number>();
  for (const line of other) left.set(line, (left.get(line) ?? 0) + 1);
  return from.filter((line) => {
    const count = left.get(line) ?? 0;
    left.set(line, count - 1);
    return count <= 0;
  });
}

/** A resumed session keeps the system text it started with. Prepends what
 * changed since `delivered` to this turn's text; null when the change is
 * too big for that and the session should recycle instead. */
export function withSystemChanges(
  text: string,
  delivered: string | undefined,
  system: string,
  maxChars = SYSTEM_REMINDER_MAX_CHARS,
): string | null {
  if (delivered === undefined || delivered === system) return text;
  const before = systemLines(delivered);
  const after = systemLines(system);
  const removed = linesOnlyIn(before, after);
  const added = linesOnlyIn(after, before);
  if (!removed.length && !added.length) return text;
  if ([...removed, ...added].reduce((sum, line) => sum + line.length, 0) > maxChars) return null;
  // Untagged, Haiku kept the stale system prompt in about half of real-CLI
  // trials; the CLI's own prompt treats tags in a user message as system info.
  return [
    "<system-reminder>",
    SYSTEM_REMINDER_HEADER,
    ...(removed.length ? ["[Removed:]", ...removed] : []),
    ...(added.length ? ["[Added:]", ...added] : []),
    "</system-reminder>",
    "",
    text,
  ].join("\n");
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";
const RECYCLED_PREAMBLE =
  "[Wink compacted this conversation to keep the provider session bounded. The conversation so far:]";
const SESSION_FAT_PREAMBLE =
  "[Wink started a fresh provider session to keep tool history bounded. The conversation so far:]";
const SYSTEM_CHANGED_PREAMBLE =
  "[Wink started a fresh provider session because your instructions changed. The conversation so far:]";

function replayPreamble(input: TurnContextInput): string {
  if (input.rewound) return REWOUND_PREAMBLE;
  if (input.recycled) {
    return input.recycleReason === "compaction"
      ? RECYCLED_PREAMBLE
      : input.recycleReason === "system" ? SYSTEM_CHANGED_PREAMBLE : SESSION_FAT_PREAMBLE;
  }
  return FRESH_PREAMBLE;
}

export const TASK_RESUME_PROMPT =
  "The previous turn was interrupted. Continue from the conversation.";

/** Marks where replayed history ends and the message a driver must actually
 * answer begins. Drivers that re-attach native content (e.g. images) from
 * `<attached-image>` tags in replayed text scope that to tags after this
 * marker, so old history isn't mistaken for something the user just sent. */
export const REPLY_MARKER = "[Now reply to the user's latest message:]";

export interface TaskRecordBlockOptions {
  /** Stop / crash Resume — do not present a drifted Goal/Plan/Next as current work. */
  recovering?: boolean;
  /** Latest real user turn; ignored unless `recovering` is set. */
  latestUserText?: string;
}

function compactValue(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  const marker = " [more saved]";
  return characters.slice(0, Math.max(1, maxCharacters - marker.length)).join("").trimEnd() + marker;
}

function latestUserTextFromTranscript(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.role === "user" && message.text.trim()) return message.text;
  }
  return "";
}

function formatTaskRecordFields(
  header: string,
  fields: ReadonlyArray<readonly [string, string]>,
  maxCharacters: number,
): string {
  const limit = Math.max(512, maxCharacters);
  const valueBudget = Math.max(24, Math.floor((limit - header.length - fields.length) / Math.max(1, fields.length)) - 16);
  return redactSecretsInText([
    header,
    ...fields.map(([label, value]) => `${label}: ${compactValue(value, valueBudget)}`),
  ].join("\n"));
}

function taskRecordProgressFields(record: TaskRecordContext): Array<readonly [string, string]> {
  const recent = record.completed.slice(-3).map((item) => item.note).join(" | ") || "none recorded";
  const evidenceItems = record.evidence ?? [];
  const evidence = evidenceItems.slice(-3)
    .map((item) => `${item.kind}: ${item.ref}${item.note ? ` (${item.note})` : ""}`).join(" | ") || "none";
  const artifactItems = record.artifacts ?? [];
  const artifacts = artifactItems.slice(-3).map((item) => `${item.label}: ${item.ref}`).join(" | ") || "none";
  const blockers = record.blockers.slice(-3).map((item) => item.note).join(" | ") || "none";
  return [
    ["Done recently", `${record.completed.length} total; ${recent}`],
    ["Evidence", `${evidenceItems.length} total; ${evidence}`],
    ["Artifacts", `${artifactItems.length} total; ${artifacts}`],
    ["Blockers", `${record.blockers.length} total; ${blockers}`],
  ];
}

export function taskRecordBlock(
  record: TaskRecordContext,
  maxCharacters = 6_000,
  options?: TaskRecordBlockOptions,
): string {
  if (options?.recovering) {
    const current = (options.latestUserText ?? "").trim();
    return formatTaskRecordFields(
      "[Wink task record - local notes. The previous turn was interrupted. Continue from the conversation.]",
      [
        ...(current ? [["Current request", current] as const] : []),
        ...taskRecordProgressFields(record),
      ],
      maxCharacters,
    );
  }
  const done = record.plan.filter((item) => item.status === "done").length;
  const active = record.plan.find((item) => item.status === "active")?.step;
  const pending = record.plan.find((item) => item.status === "pending")?.step;
  const plan = record.plan.map((item, index) => `${index + 1}. ${item.status}: ${item.step}`).join(" | ") || "none";
  return formatTaskRecordFields(
    "[Wink task record - saved locally. The conversation is authoritative; verify against it.]",
    [
      ["Goal", record.goal],
      ["Plan", `${done}/${record.plan.length} done${active ? `; active: ${active}` : ""}${pending ? `; next pending: ${pending}` : ""}; steps: ${plan}`],
      ["Next action", record.nextAction],
      ...taskRecordProgressFields(record),
    ],
    maxCharacters,
  );
}

const RESUME_FALLBACK_PREAMBLE =
  "[The provider session could not be resumed. Continue from this durable Wink context:]";

export function buildResumeFallback(input: {
  text: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  taskRecord?: TaskRecordContext;
  taskRecordText?: string;
}): string {
  const record = input.taskRecordText ?? (input.taskRecord ? taskRecordBlock(input.taskRecord) : "");
  return [
    record || null,
    record ? "" : null,
    RESUME_FALLBACK_PREAMBLE,
    "",
    ...input.transcript.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`),
    "",
    REPLY_MARKER,
    "",
    input.text,
  ].filter((line) => line !== null).join("\n");
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, recycled = false, replaysNatively, taskRecord, taskRecordText, contextCapped = false, recovering = false, currentRequestText } = input;
  const resume = !rewound && !fresh && !recycled;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  // The caller already sized its block for the model window and knows this
  // send's request; re-deriving from the transcript would drop both, and the
  // transcript excludes the message this turn is answering.
  const durableRecord = taskRecordText ?? (
    taskRecord
      ? taskRecordBlock(taskRecord, 6_000, recovering
        ? {
          recovering: true,
          latestUserText: currentRequestText ?? latestUserTextFromTranscript(transcript),
        }
        : undefined)
      : ""
  );
  const record = durableRecord && (rewound || fresh || recycled || contextCapped || recovering)
    ? durableRecord
    : "";
  if (!replay && !record) return { turnText: text, resume };
  if (!replay) return { turnText: `${record}\n\n${text}`, resume };
  return {
    turnText: [
      record,
      record ? "" : null,
      replayPreamble(input),
      "",
      ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
      "",
      REPLY_MARKER,
      "",
      text,
    ].filter((line) => line !== null).join("\n"),
    resume,
  };
}
