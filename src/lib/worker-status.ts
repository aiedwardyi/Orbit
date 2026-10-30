import type { Translate } from "./i18n";
import { parseWorkerLabel, workerRuns, type WorkerShownState } from "./worker-runs";

export function workerStatusText(runs: readonly { state: WorkerShownState }[], t: Translate): string {
  if (!runs.some(({ state }) => state === "working" || state === "waiting")) return "";
  const count = runs.length;
  return t(count === 1 ? "workers.countOne" : "workers.countMany", { count });
}

export function sidebarWorkerStatus(messages: Parameters<typeof workerRuns>[0], labels: readonly string[], t: Translate): string {
  if (!labels.length) return "";
  const runs = workerRuns(messages);
  const states = labels.map((label) => {
    const nick = parseWorkerLabel(label).nick;
    const matched = runs.find((run) => run.nick === nick || run.notes.some(({ note }) => parseWorkerLabel(note.label).nick === nick));
    const run = matched && runs.filter((run) => run.pane8 === matched.pane8).sort((a, b) => b.latest.at - a.latest.at || b.latest.index - a.latest.index)[0];
    return { state: run?.state ?? "working" };
  });
  return workerStatusText(states, t);
}
