import type { Message } from "../../server/store.ts";
import { parsePaneNote, type PaneNote } from "../../shared/pane-note.ts";

type WorkerMessage = Pick<Message, "id" | "at" | "role" | "kind" | "text" | "from">;

export type WorkerState = "working" | "waiting" | "failed" | "done";
/** `ended` only comes from client pane liveness, never from the transcript. */
export type WorkerShownState = WorkerState | "ended";

export type WorkerRun = {
  id: string;
  nick: string;
  /** The MODEL part of a `NICK | MODEL | EFFORT` label. */
  model: string | null;
  /** The EFFORT part, lowercased; null when the label names no known effort. */
  effort: string | null;
  /** A ProviderMark driver kind, "script", or null when the model names no known provider. */
  provider: string | null;
  state: WorkerState;
  at: number;
  latest: { at: number; index: number };
  pane8: string | null;
  sessionId: string | null;
  folder: string | null;
  /** Rooms: the member that launched it. */
  botId: string | null;
  /** Launch rows first, then notes, each in transcript order. */
  messageIds: string[];
  notes: Array<{ id: string; at: number; note: PaneNote }>;
};

const PROVIDERS: Array<[RegExp, string]> = [
  [/^script\b/i, "script"],
  [/\b(opus|sonnet|haiku|fable|claude)(?=\b|\d)/i, "claudeAgent"],
  [/\b(gpt|codex|astra|sol|terra|luna)(?=\b|\d)/i, "codex"],
  [/\bgemini(?=\b|\d)/i, "geminiAgent"],
  [/\bgrok(?=\b|\d)/i, "grokAgent"],
  [/\b(muse|meta|llama)(?=\b|\d)/i, "museAgent"],
  [/\bkimi(?=\b|\d)/i, "kimiAgent"],
  [/\bqwen(?=\b|\d)/i, "qwenAgent"],
];

export function workerProvider(model: string | null): string | null {
  if (!model) return null;
  return PROVIDERS.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

const EFFORT_RE = /^(?:(?:extra|x)[\s-]*high|minimal|low|medium|high|max)\b/;

/** Third label part, lowercased; `extra high` in any spelling reads as `xhigh`, and a trailing note like `high API` is dropped. */
function normalizeEffort(part: string | undefined): string | null {
  const effort = EFFORT_RE.exec((part ?? "").trim().toLowerCase())?.[0];
  if (!effort) return null;
  return effort.endsWith("high") && effort !== "high" ? "xhigh" : effort;
}

export function parseWorkerLabel(label: string | null | undefined) {
  const [nick, model, effort] = (label ?? "").split("|").map((part) => part.trim());
  return { nick: nick || null, model: model || null, effort: normalizeEffort(effort) };
}

const URGENCY = { waiting: 0, failed: 1, working: 2, done: 3, ended: 4 } satisfies Record<WorkerShownState, number>;

export function byUrgency<T extends { run: WorkerRun; state: WorkerShownState }>(a: T, b: T): number {
  return URGENCY[a.state] - URGENCY[b.state] || Number(a.run.provider === "script") - Number(b.run.provider === "script") || a.run.at - b.run.at;
}

/** Pane this run opens. A note-only run matches when one live id starts with its pane8. */
export function listedSessionId(run: { sessionId: string | null; pane8: string | null }, livePanes: ReadonlySet<string> | null): string | null {
  if (run.sessionId) return livePanes?.has(run.sessionId) ? run.sessionId : null;
  const pane8 = run.pane8;
  if (!livePanes || !pane8) return null;
  const matches = [...livePanes].filter((id) => id.startsWith(pane8));
  const [only, extra] = matches;
  return extra === undefined ? only ?? null : null;
}

type ShownLike = { run: WorkerRun; state: WorkerShownState };

/** Newest transcript run per live pane. */
function paneRuns<T extends ShownLike>(runs: readonly T[], livePanes: ReadonlySet<string>): Map<string, T> {
  const panes = new Map<string, T>();
  for (const shown of runs) {
    const sessionId = listedSessionId(shown.run, livePanes);
    if (!sessionId) continue;
    const held = panes.get(sessionId);
    const latest = shown.run.latest;
    if (!held || latest.at > held.run.latest.at || (latest.at === held.run.latest.at && latest.index > held.run.latest.index)) panes.set(sessionId, shown);
  }
  return panes;
}

/** Live panes in any state; one with no transcript run gets a working placeholder. Unknown liveness keeps today's working and waiting runs. */
export function listedRuns(runs: readonly ShownLike[], livePanes: ReadonlySet<string> | null, labels?: ReadonlyMap<string, string>): ShownLike[] {
  if (!livePanes) return runs.filter((shown) => shown.state === "working" || shown.state === "waiting").sort(byUrgency);
  const panes = paneRuns(runs, livePanes);
  const listed = [...panes.values()];
  const claimed = new Set(panes.keys());
  for (const sessionId of livePanes) {
    if (claimed.has(sessionId)) continue;
    const pane8 = sessionId.slice(0, 8);
    const { nick, model, effort } = parseWorkerLabel(labels?.get(sessionId));
    listed.push({
      state: "working",
      run: { id: `pane:${sessionId}`, nick: nick ?? pane8, model, effort, provider: workerProvider(model), state: "working", at: Number.MAX_SAFE_INTEGER, latest: { at: 0, index: 0 }, pane8, sessionId, folder: null, botId: null, messageIds: [], notes: [] },
    });
  }
  return listed.sort(byUrgency);
}

export function latestPaneRun(runs: readonly WorkerRun[], sessionId: string): WorkerRun | undefined {
  return paneRuns(runs.map((run) => ({ run, state: run.state })), new Set([sessionId])).get(sessionId)?.run;
}

/** True when the pane's run is still the one captured before a snapshot await. */
export function samePaneRun(before: WorkerRun | undefined, after: WorkerRun | undefined): boolean {
  if (!before || !after) return before === after;
  return before.id === after.id
    && before.messageIds.at(-1) === after.messageIds.at(-1)
    && before.latest.at === after.latest.at
    && before.latest.index === after.latest.index;
}

export function shownState(run: WorkerRun, livePanes: Set<string> | null): WorkerShownState {
  if (!livePanes || run.state === "done" || run.state === "failed") return run.state;
  const live = run.sessionId ? livePanes.has(run.sessionId) : run.pane8 ? [...livePanes].some((id) => id.startsWith(run.pane8!)) : true;
  return live ? run.state : "ended";
}

/** Each run renders once at its retained mounted anchor; null folds its other messages. */
export function workerAnchors<T extends { run: WorkerRun }>(workers: readonly T[], mounted: readonly WorkerMessage[], anchors?: ReadonlyMap<string, string>): Map<string, T | null> {
  const ids = new Set(mounted.map((m) => m.id));
  const at = new Map<string, T | null>();
  for (const shown of workers) {
    const held = anchors?.get(shown.run.id);
    const anchor = held && ids.has(held) && shown.run.messageIds.includes(held) ? held : shown.run.messageIds.find((id) => ids.has(id));
    for (const id of shown.run.messageIds) at.set(id, id === anchor ? shown : null);
  }
  return at;
}

function noteState(note: PaneNote): WorkerState {
  if (note.status === "done") return "done";
  if (note.status === "failed") return "failed";
  if (note.status === "blocked" || note.alert) return "waiting";
  return "working";
}

/** One run per worker pane job, keyed by pane and nickname. */
export function workerRuns(messages: readonly WorkerMessage[], older: readonly WorkerMessage[] = []): WorkerRun[] {
  const transcript = older.length ? [...new Map([...older, ...messages].map((message) => [message.id, message])).values()].sort((a, b) => a.at - b.at) : messages;
  const runs = new Map<string, WorkerRun>();
  // newest run per pane, for notes that carry no nickname of their own
  const paneRun = new Map<string, WorkerRun>();
  const paneNotes = new Map<string, { at: number; index: number }>();
  const events = new Map<WorkerRun, Array<{ at: number; index: number; state: WorkerState; launch?: boolean; resume?: boolean }>>();
  const launches = new Map<WorkerRun, number>();
  const add = (key: string, seed: Omit<WorkerRun, "id" | "state" | "latest" | "messageIds" | "notes">, index: number): WorkerRun => {
    let run = runs.get(key);
    if (!run) {
      run = { ...seed, id: key, state: "working", latest: { at: seed.at, index }, messageIds: [], notes: [] };
      runs.set(key, run);
      events.set(run, []);
    }
    if (seed.at > run.latest.at || (seed.at === run.latest.at && index > run.latest.index)) run.latest = { at: seed.at, index };
    if (seed.pane8) paneRun.set(`${seed.botId ?? ""}:${seed.pane8}`, run);
    return run;
  };
  transcript.forEach((message, index) => {
    const botId = message.from?.botId ?? null;
    if (message.kind === "launch") {
      const [header = "", ...details] = (message.text ?? "").split("\n");
      const field = (name: string) => details.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim() || null;
      const resumed = header.startsWith("Resumed ");
      const label = field("Label") ?? header.replace(/^(?:Launched|Resumed) /, "");
      const { nick, model, effort } = parseWorkerLabel(label);
      const sessionId = field("Session");
      const pane8 = sessionId?.slice(0, 8) ?? null;
      const name = nick ?? pane8 ?? "pane";
      const key = pane8 ? `${botId ?? ""}:${pane8}:${name.toLowerCase()}` : message.id;
      const run = add(key, { nick: name, model, effort, provider: workerProvider(model), at: message.at, pane8, sessionId, folder: field("Working folder"), botId }, index);
      run.sessionId ??= sessionId;
      run.folder ??= field("Working folder");
      // A follow-up is not a leading launch, so the row stays where it is.
      if (resumed) {
        run.messageIds.push(message.id);
        const submitted = field("Submitted");
        const parsed = submitted && /^\d{1,16}$/.test(submitted) ? Number(submitted) : Number.NaN;
        // The row can land after the report; order it by when the line was submitted.
        events.get(run)!.push({ at: Number.isSafeInteger(parsed) ? parsed : message.at, index, state: "working", resume: true });
        return;
      }
      // a launch after its notes in the transcript still leads, so the row sits at the launch
      const launched = launches.get(run) ?? 0;
      run.messageIds.splice(launched, 0, message.id);
      launches.set(run, launched + 1);
      run.at = Math.min(run.at, message.at);
      events.get(run)!.push({ at: message.at, index, state: "working", launch: true });
      return;
    }
    if (message.kind !== "note" || !message.text) return;
    const note = parsePaneNote(message.text);
    if (!note.pane8) return;
    const labelled = parseWorkerLabel(note.label);
    // A restart note lists several dead panes, so it is Wink's own row, not its first pane's.
    const nick = note.alert?.kind === "restarted" ? "Wink" : note.nick ?? (paneRun.get(`${botId ?? ""}:${note.pane8}`)?.nick || labelled.nick || note.pane8);
    const key = `${botId ?? ""}:${note.pane8}:${nick.toLowerCase()}`;
    const run = add(key, { nick, model: labelled.model, effort: labelled.effort, provider: workerProvider(labelled.model), at: message.at, pane8: note.pane8, sessionId: null, folder: null, botId }, index);
    run.messageIds.push(message.id);
    run.notes.push({ id: message.id, at: message.at, note });
    events.get(run)!.push({ at: message.at, index, state: noteState(note) });
    const pane = `${botId ?? ""}:${note.pane8}`;
    const newest = paneNotes.get(pane);
    if (!newest || message.at > newest.at || (message.at === newest.at && index > newest.index)) paneNotes.set(pane, { at: message.at, index });
  });
  for (const [run, list] of events) {
    const noted = run.pane8 ? paneNotes.get(`${run.botId ?? ""}:${run.pane8}`) : undefined;
    const pending = list.filter((event) => !event.resume || !noted || event.at > noted.at || (event.at === noted.at && event.index >= noted.index));
    if (!pending.length) {
      runs.delete(run.id);
      continue;
    }
    // A fast pane's final report can land before its launch note.
    const updates = pending.some((event) => event.state === "done" || event.state === "failed") ? pending.filter((event) => !event.launch) : pending;
    run.state = updates.reduce((newest, event) => (event.at > newest.at || (event.at === newest.at && event.index > newest.index) ? event : newest)).state;
    run.notes.sort((a, b) => a.at - b.at);
  }
  return [...runs.values()];
}
