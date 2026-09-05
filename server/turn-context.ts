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
   */
  recycleReason?: "compaction" | "session-fat";
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
 * last turn was tool-heavy, settled tools since the last compact exceed
 * the session budget, or the provider reported native input over half
 * the model window — the same share compaction uses.
 *
 * Stop / crash Continuity still `--resume`s when there is no compaction
 * yet, even if the session is already fat. A rewind already drops resume
 * on its own path.
 */
export const PRE_COMPACT_TOOL_ROUND_LIMIT = 24;
export const PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT = 48;
const NATIVE_SESSION_BUDGET_SHARE = 0.5;

export function nativeSessionTokenBudget(contextWindow: number): number {
  return Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.max(1, Math.floor(contextWindow * NATIVE_SESSION_BUDGET_SHARE))
    : 0;
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

/** Settled tool chips after the previous user line (the last completed soak). */
export function countLastTurnToolRounds(
  messages: readonly SessionFatMessage[],
  excludeIds?: ReadonlySet<string>,
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id && excludeIds?.has(message.id)) continue;
    if (message.kind === "text" && message.role === "user") break;
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
}): boolean {
  if (input.rewound) return false;
  // Compaction always forces a recycle regardless of recovery state: a
  // recovered session that was then compacted must start fresh.
  if (input.compacted) return true;
  if (input.recovering) return false;
  if ((input.lastTurnToolRounds ?? 0) >= PRE_COMPACT_TOOL_ROUND_LIMIT) return true;
  if ((input.sessionToolRounds ?? 0) >= PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT) return true;
  const budget = input.nativeTokenBudget ?? 0;
  return budget > 0 && (input.lastTurnInputTokens ?? 0) > budget;
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";
const RECYCLED_PREAMBLE =
  "[Orbit compacted this conversation to keep the provider session bounded. The conversation so far:]";
const SESSION_FAT_PREAMBLE =
  "[Orbit started a fresh provider session to keep tool history bounded. The conversation so far:]";

function replayPreamble(input: TurnContextInput): string {
  if (input.rewound) return REWOUND_PREAMBLE;
  if (input.recycled) {
    return input.recycleReason === "compaction" ? RECYCLED_PREAMBLE : SESSION_FAT_PREAMBLE;
  }
  return FRESH_PREAMBLE;
}

export const TASK_RESUME_PROMPT =
  "The previous turn was interrupted. Continue from the conversation.";

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
      "[Orbit task record - local notes. The previous turn was interrupted. Continue from the conversation.]",
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
    "[Orbit task record - saved locally. The conversation is authoritative; verify against it.]",
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
  "[The provider session could not be resumed. Continue from this durable Orbit context:]";

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
    "[Now reply to the user's latest message:]",
    "",
    input.text,
  ].filter((line) => line !== null).join("\n");
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, recycled = false, replaysNatively, taskRecord, taskRecordText, contextCapped = false, recovering = false } = input;
  const resume = !rewound && !fresh && !recycled;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  const durableRecord = recovering && taskRecord
    ? taskRecordBlock(taskRecord, 6_000, {
      recovering: true,
      latestUserText: latestUserTextFromTranscript(transcript),
    })
    : taskRecordText ?? (taskRecord ? taskRecordBlock(taskRecord) : "");
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
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].filter((line) => line !== null).join("\n"),
    resume,
  };
}
