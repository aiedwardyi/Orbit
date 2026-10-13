import fs from "node:fs";
import path from "node:path";

const RETRY_MS = 15_000;
const TRIES = 20;
const MISSES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRuns(file) {
  try {
    const runs = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

/** Each bot's spawned panes, written on every change so a crash still leaves the record. */
export function createPaneRuns(file) {
  const runs = new Map(readRuns(file).filter((run) => run?.state === "running").map((run) => [run.id, run]));
  const prior = new Set(runs.keys());
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify([...runs.values()]));
      fs.renameSync(temporary, file);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
    }
  };
  const mark = (id, state) => {
    const run = runs.get(id);
    if (!run || prior.has(id) || run.state === state) return;
    run.state = state;
    save();
  };
  save();
  return {
    started({ id, botId, teacher, label, cwd, spawnedAt }) {
      const run = { id, botId, teacher, label: label ?? null, cwd, spawnedAt, state: "running" };
      const stored = runs.get(id);
      if (stored && Object.keys(run).every((key) => stored[key] === run[key])) return;
      runs.set(id, run);
      save();
    },
    reported: (id) => mark(id, "reported"),
    ended: (id) => mark(id, "ended"),
    closed(id) {
      if (runs.delete(id)) save();
    },
    /** Panes a previous run left mid-run, by the bot that spawned them. */
    restarted() {
      const bots = new Map();
      for (const id of prior) {
        const run = runs.get(id);
        if (run) bots.set(run.botId, [...(bots.get(run.botId) ?? []), run]);
      }
      return bots;
    },
    forget(botId) {
      for (const id of prior) {
        if (runs.get(id)?.botId !== botId) continue;
        runs.delete(id);
        prior.delete(id);
      }
      save();
    },
    /** Counts a launch whose note never landed; returns how many records that dropped. */
    missed(botId) {
      let dropped = 0;
      for (const id of prior) {
        const run = runs.get(id);
        if (run?.botId !== botId) continue;
        run.missed = (run.missed ?? 0) + 1;
        if (run.missed < MISSES) continue;
        runs.delete(id);
        prior.delete(id);
        dropped++;
      }
      save();
      return dropped;
    },
  };
}

export function restartNoteText(panes) {
  const lines = panes.map((pane) => `- ${pane.label ? `${pane.label} ` : ""}[pane ${pane.id.slice(0, 8)}] in ${pane.cwd}, spawned ${new Date(pane.spawnedAt).toISOString()}`);
  return `RESTARTED: Wink restarted, so these panes you spawned closed mid-run:\n${lines.join("\n")}\nEdits in their folders are still there. Spawn a FRESH worker to continue, or tell the user.`;
}

/** One note per bot, through the pane mailbox so it wakes the bot once. */
export async function notifyRestartedPanes({ runs, mailbox, notePane, retryMs = RETRY_MS, tries = TRIES, warn = () => {} }) {
  const bots = runs.restarted();
  if (!bots.size) return;
  const mail = await Promise.resolve().then(mailbox).catch(() => null);
  await Promise.all([...bots].map(async ([botId, panes]) => {
    const scope = { pane: panes[0].id, bot: botId, teacher: panes[0].teacher ?? botId };
    let reason = "no mailbox";
    for (let attempt = 1; mail && attempt <= tries; attempt++) {
      try {
        await notePane(mail, scope, restartNoteText(panes));
        return runs.forget(botId);
      } catch (error) {
        reason = error?.message ?? error;
        if (attempt < tries) await sleep(retryMs);
      }
    }
    const dropped = runs.missed(botId);
    warn(`restart note for ${botId} not delivered: ${reason}`);
    if (dropped) warn(`restart note for ${botId} dropped ${dropped} pane(s) after ${MISSES} launches`);
  }));
}
