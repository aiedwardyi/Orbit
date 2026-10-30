import type { Translate } from "./i18n";
import { parseWorkerLabel, workerRuns, type WorkerShownState } from "./worker-runs";

export function workerStatusText(runs: readonly { state: WorkerShownState }[], t: Translate): string {
  if (!runs.some(({ state }) => state === "working" || state === "waiting")) return "";
  const count = runs.length;
  return t(count === 1 ? "workers.countOne" : "workers.countMany", { count });
}

export function sidebarWorkerStatus(messages: Parameters<typeof workerRuns>[0], labels: readonly string[], t: Translate): string {
  if (!labels.length) return "";
  const runs = workerRuns(messages).sort((a, b) => b.latest.at - a.latest.at || b.latest.index - a.latest.index);
  const states = labels.map((label) => {
    const nick = parseWorkerLabel(label).nick;
    const matched = nick === null ? undefined : runs.find((run) => run.nick === nick || run.notes.some(({ note }) => parseWorkerLabel(note.label).nick === nick));
    const run = matched?.pane8 ? runs.find((run) => run.pane8 === matched.pane8) : matched;
    return { state: run?.state ?? "working" };
  });
  return workerStatusText(states, t);
}
