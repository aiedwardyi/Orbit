import type { Translate } from "./i18n";
import { listedRuns, parseWorkerLabel, workerRuns, type WorkerRun, type WorkerShownState } from "./worker-runs";

type ShownRun = { run: WorkerRun; state: WorkerShownState };

export function workerStatusRuns(runs: ShownRun[], livePanes: Set<string> | null, labels?: ReadonlyMap<string, string>): ShownRun[] {
  const listed = listedRuns(runs, livePanes, labels);
  if (listed.length) return listed;
  const latest = new Map<string, ShownRun>();
  for (const shown of runs) {
    const key = `${shown.run.botId ?? ""}:${shown.run.pane8 ?? shown.run.sessionId ?? shown.run.id}`;
    const held = latest.get(key);
    if (!held || shown.run.latest.at > held.run.latest.at || (shown.run.latest.at === held.run.latest.at && shown.run.latest.index > held.run.latest.index)) latest.set(key, shown);
  }
  return [...latest.values()].filter(({ state }) => state === "done" || state === "failed");
}

export function workerStatusText(runs: readonly { state: WorkerShownState }[], t: Translate): string {
  if (!runs.length) return "";
  const waiting = runs.filter(({ state }) => state === "waiting").length;
  const failed = runs.filter(({ state }) => state === "failed").length;
  const count = runs.length;
  if (waiting || failed) return [
    t(count === 1 ? "workers.countOne" : "workers.countMany", { count }),
    waiting ? t("workers.waitingCount", { count: waiting }) : "",
    failed ? t("workers.failedCount", { count: failed }) : "",
  ].filter(Boolean).join(" · ");
  const done = runs.every(({ state }) => state === "done" || state === "ended");
  return t(done ? count === 1 ? "workers.doneOne" : "workers.doneMany" : count === 1 ? "workers.workingOne" : "workers.workingMany", { count });
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
  return states.some(({ state }) => state === "working" || state === "waiting") ? workerStatusText(states, t) : "";
}
