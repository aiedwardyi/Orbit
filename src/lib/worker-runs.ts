import type { Message } from "@/state/store";
import { parsePaneNote, type PaneNote } from "../../shared/pane-note";

export type WorkerState = "working" | "waiting" | "failed" | "done";
/** `ended` only comes from client pane liveness, never from the transcript. */
export type WorkerShownState = WorkerState | "ended";

export type WorkerRun = {
  id: string;
  nick: string;
  /** The MODEL part of a `NICK | MODEL | EFFORT` label. */
  model: string | null;
  /** A ProviderMark driver kind, "script", or null when the model names no known provider. */
  provider: string | null;
  state: WorkerState;
  at: number;
  pane8: string | null;
  sessionId: string | null;
  folder: string | null;
  /** Rooms: the member that launched it. */
  botId: string | null;
  /** Launch rows first, then notes, each in transcript order. The first one mounted is where the row renders. */
  messageIds: string[];
  notes: Array<{ id: string; at: number; note: PaneNote }>;
};

const PROVIDERS: Array<[RegExp, string]> = [
  [/^script\b/i, "script"],
  [/\b(opus|sonnet|haiku|fable|claude)\b/i, "claudeAgent"],
  [/\b(gpt|codex)\b/i, "codex"],
  [/\bgemini\b/i, "geminiAgent"],
  [/\bgrok\b/i, "grokAgent"],
  [/\b(muse|meta|llama)\b/i, "museAgent"],
  [/\bkimi\b/i, "kimiAgent"],
  [/\bqwen\b/i, "qwenAgent"],
];

export function workerProvider(model: string | null): string | null {
  if (!model) return null;
  return PROVIDERS.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

export function parseWorkerLabel(label: string | null | undefined) {
  const [nick, model] = (label ?? "").split("|").map((part) => part.trim());
  return { nick: nick || null, model: model || null };
}

const URGENCY = { waiting: 0, failed: 1, working: 2, done: 3, ended: 4 } satisfies Record<WorkerShownState, number>;

export function byUrgency<T extends { run: WorkerRun; state: WorkerShownState }>(a: T, b: T): number {
  return URGENCY[a.state] - URGENCY[b.state] || a.run.at - b.run.at;
}

export function shownState(run: WorkerRun, livePanes: Set<string> | null): WorkerShownState {
  if (!livePanes || run.state === "done" || run.state === "failed") return run.state;
  const live = run.sessionId ? livePanes.has(run.sessionId) : run.pane8 ? [...livePanes].some((id) => id.startsWith(run.pane8!)) : true;
  return live ? run.state : "ended";
}

/** Each run renders once, at its first mounted message; null marks the ones that fold into it. */
export function workerAnchors<T extends { run: WorkerRun }>(workers: readonly T[], mounted: readonly Message[]): Map<string, T | null> {
  const ids = new Set(mounted.map((m) => m.id));
  const at = new Map<string, T | null>();
  for (const shown of workers) {
    const anchor = shown.run.messageIds.find((id) => ids.has(id));
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

/** One run per worker pane job, keyed by pane and nickname. The newest event by time sets the state. */
export function workerRuns(messages: readonly Message[]): WorkerRun[] {
  const runs = new Map<string, WorkerRun>();
  // newest run per pane, for notes that carry no nickname of their own
  const paneRun = new Map<string, WorkerRun>();
  const events = new Map<WorkerRun, Array<{ at: number; index: number; state: WorkerState }>>();
  const launches = new Map<WorkerRun, number>();
  const add = (key: string, seed: Omit<WorkerRun, "id" | "state" | "messageIds" | "notes">): WorkerRun => {
    let run = runs.get(key);
    if (!run) {
      run = { ...seed, id: key, state: "working", messageIds: [], notes: [] };
      runs.set(key, run);
      events.set(run, []);
    }
    if (seed.pane8) paneRun.set(`${seed.botId ?? ""}:${seed.pane8}`, run);
    return run;
  };
  messages.forEach((message, index) => {
    const botId = message.from?.botId ?? null;
    if (message.kind === "launch") {
      const [header = "", ...details] = (message.text ?? "").split("\n");
      const field = (name: string) => details.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim() || null;
      const label = field("Label") ?? header.replace(/^Launched /, "");
      const { nick, model } = parseWorkerLabel(label);
      const sessionId = field("Session");
      const pane8 = sessionId?.slice(0, 8) ?? null;
      const name = nick ?? pane8 ?? "pane";
      const key = pane8 ? `${botId ?? ""}:${pane8}:${name.toLowerCase()}` : message.id;
      const run = add(key, { nick: name, model, provider: workerProvider(model), at: message.at, pane8, sessionId, folder: field("Working folder"), botId });
      // a launch after its notes in the transcript still leads, so the row sits at the launch
      const launched = launches.get(run) ?? 0;
      run.messageIds.splice(launched, 0, message.id);
      launches.set(run, launched + 1);
      run.sessionId ??= sessionId;
      run.folder ??= field("Working folder");
      run.at = Math.min(run.at, message.at);
      events.get(run)!.push({ at: message.at, index, state: "working" });
      return;
    }
    if (message.kind !== "note" || !message.text) return;
    const note = parsePaneNote(message.text);
    if (!note.pane8) return;
    const labelled = parseWorkerLabel(note.label);
    const nick = note.nick ?? (paneRun.get(`${botId ?? ""}:${note.pane8}`)?.nick || labelled.nick || note.pane8);
    const key = `${botId ?? ""}:${note.pane8}:${nick.toLowerCase()}`;
    const run = add(key, { nick, model: labelled.model, provider: workerProvider(labelled.model), at: message.at, pane8: note.pane8, sessionId: null, folder: null, botId });
    run.messageIds.push(message.id);
    run.notes.push({ id: message.id, at: message.at, note });
    events.get(run)!.push({ at: message.at, index, state: noteState(note) });
  });
  for (const [run, list] of events) {
    run.state = list.reduce((newest, event) => (event.at > newest.at || (event.at === newest.at && event.index > newest.index) ? event : newest)).state;
    run.notes.sort((a, b) => a.at - b.at);
  }
  return [...runs.values()];
}
