import { redactSecretsInText } from "./redact.ts";

// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed), a fresh engine (this instance has no session here — the user
// switched the bot's model mid-thread), and a recycled session (Orbit
// compacted the thread, so a CLI `--resume` of the pre-compact session
// would bypass the bound). They coincide today but are distinct markers
// on purpose: rewound also invalidates OTHER instances' cursors; recycle
// drops this task's cursors so the next turn injects summary+tail.
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
   * Orbit compacted this thread (summary + tail is now the source of truth).
   * CLI `--resume` / thread-resume would re-send the native session — full
   * tool payloads and uncompacted history — and bypass that bound.
   */
  recycled?: boolean;
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
 * Stop / crash Continuity still `--resume`s when there is no compaction
 * yet. A rewind already drops resume on its own path.
 */
export function shouldRecycleProviderSession(input: {
  compacted: boolean;
  rewound?: boolean;
}): boolean {
  return Boolean(input.compacted) && !input.rewound;
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";
const RECYCLED_PREAMBLE =
  "[Orbit compacted this conversation to keep the provider session bounded. The conversation so far:]";

function compactValue(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  const marker = " [more saved]";
  return characters.slice(0, Math.max(1, maxCharacters - marker.length)).join("").trimEnd() + marker;
}

export function taskRecordBlock(record: TaskRecordContext, maxCharacters = 6_000): string {
  const done = record.plan.filter((item) => item.status === "done").length;
  const active = record.plan.find((item) => item.status === "active")?.step;
  const pending = record.plan.find((item) => item.status === "pending")?.step;
  const plan = record.plan.map((item, index) => `${index + 1}. ${item.status}: ${item.step}`).join(" | ") || "none";
  const recent = record.completed.slice(-3).map((item) => item.note).join(" | ") || "none recorded";
  const evidenceItems = record.evidence ?? [];
  const evidence = evidenceItems.slice(-3)
    .map((item) => `${item.kind}: ${item.ref}${item.note ? ` (${item.note})` : ""}`).join(" | ") || "none";
  const artifactItems = record.artifacts ?? [];
  const artifacts = artifactItems.slice(-3).map((item) => `${item.label}: ${item.ref}`).join(" | ") || "none";
  const blockers = record.blockers.slice(-3).map((item) => item.note).join(" | ") || "none";
  const fields = [
    ["Goal", record.goal],
    ["Plan", `${done}/${record.plan.length} done${active ? `; active: ${active}` : ""}${pending ? `; next pending: ${pending}` : ""}; steps: ${plan}`],
    ["Next action", record.nextAction],
    ["Done recently", `${record.completed.length} total; ${recent}`],
    ["Evidence", `${evidenceItems.length} total; ${evidence}`],
    ["Artifacts", `${artifactItems.length} total; ${artifacts}`],
    ["Blockers", `${record.blockers.length} total; ${blockers}`],
  ] as const;
  const header = "[Orbit task record - saved locally. The conversation is authoritative; verify against it.]";
  const limit = Math.max(512, maxCharacters);
  const valueBudget = Math.max(24, Math.floor((limit - header.length - fields.length) / fields.length) - 16);
  return redactSecretsInText([
    header,
    ...fields.map(([label, value]) => `${label}: ${compactValue(value, valueBudget)}`),
  ].join("\n"));
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
  const durableRecord = taskRecordText ?? (taskRecord ? taskRecordBlock(taskRecord) : "");
  const record = durableRecord && (rewound || fresh || recycled || contextCapped || recovering)
    ? durableRecord
    : "";
  if (!replay && !record) return { turnText: text, resume };
  if (!replay) return { turnText: `${record}\n\n${text}`, resume };
  return {
    turnText: [
      record,
      record ? "" : null,
      rewound ? REWOUND_PREAMBLE : fresh ? FRESH_PREAMBLE : RECYCLED_PREAMBLE,
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
