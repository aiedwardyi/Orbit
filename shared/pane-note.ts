// A stored pane note, split into what a person reads and what only the bot needs.
export type PaneNoteStatus = "done" | "failed" | "blocked";
export type PaneNoteAlert = { kind: "stalled"; minutes: number } | { kind: "waiting" };
export type PaneNote = {
  pane8: string | null;
  label: string | null;
  /** The task nick from a report header. */
  nick: string | null;
  status: PaneNoteStatus | null;
  /** Wink's own watcher notes; their text is instructions to the bot. */
  alert: PaneNoteAlert | null;
  body: string;
};

// mailboxNoteText: `[pane <8>] [<label>] from <name> (<bot id>): <text>`
const PREFIX = /^\[pane ([0-9a-f]{1,8})\](?: \[([^\]]+)\])?(?: from [^\n]*? \([^()\s]*\):)?[ \t]*/;
// orbit-msg --report: `<STATUS> <NICK> branch=<b> sha=<s> dirty=<d>`
const REPORT = /^(DONE|FAIL|BLOCKED) (\S+)((?: [a-z]+=\S*)*)[ \t]*(?:\r?\n|$)/;
const STATUS = { DONE: "done", FAIL: "failed", BLOCKED: "blocked" } as const;
// electron/terminal-host.mjs stallNoteText and electron/terminal-mailbox.mjs WAITING_NOTE
const STALLED = /^STALLED: no screen change for (\d+) min and no report\./;
const WAITING = /^WAITING: this worker is stuck on an on-screen prompt/;
const TRUNCATED = /\n\[truncated\]$/;

/** Works on a stored note or on the raw text a pane posted. */
export function parsePaneNote(text: string): PaneNote {
  const prefix = PREFIX.exec(text);
  let rest = prefix ? text.slice(prefix[0].length) : text;
  const truncated = TRUNCATED.test(rest);
  if (truncated) rest = rest.replace(TRUNCATED, "");
  const note: PaneNote = { pane8: prefix?.[1] ?? null, label: prefix?.[2] ?? null, nick: null, status: null, alert: null, body: "" };
  const stalled = STALLED.exec(rest);
  if (stalled) return { ...note, alert: { kind: "stalled", minutes: Number(stalled[1]) } };
  if (WAITING.test(rest)) return { ...note, alert: { kind: "waiting" } };
  const report = REPORT.exec(rest);
  if (report) {
    // SAFETY: REPORT captures only DONE, FAIL or BLOCKED.
    note.status = STATUS[report[1] as keyof typeof STATUS];
    note.nick = report[2] ?? null;
    rest = rest.slice(report[0].length);
  }
  note.body = rest.trim() + (truncated ? "…" : "");
  return note;
}
