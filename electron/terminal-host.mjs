import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postPaneNote, terminalPaneEnv } from "./terminal-mailbox.mjs";
import { spawnTerminalPty } from "./terminal-pty.mjs";
import { createTerminalScreen } from "./terminal-screen.mjs";

const require = createRequire(import.meta.url);
const OUTPUT_LIMIT = 256 * 1024;
const READY_TIMEOUT_MS = 5_000;
const WINDOWS_READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 500;
const QUIT_PANE_MS = 1_000;
export const TERMINAL_ACTIVITY_COALESCE_MS = 750;
export const TERMINAL_ACTIVITY_ACK_COOLDOWN_MS = 3_000;
export const TERMINAL_STALL_MS = 120_000;
export const TERMINAL_TURN_END_MS = 90_000;
// A worker idle on its own background jobs keeps its turn-end note this long at most.
const JOBS_HOLD_MS = 30 * 60_000;
// Long enough for an agent woken by its finished job to show busy and drop the note.
const JOBS_QUIET_MS = 30_000;
const JOBS_FOOTER_LINES = 4;
const STALL_CHECK_MS = 10_000;
const CODEX_CAPACITY_WAIT_MS = 60_000;
const CODEX_CAPACITY_COOLDOWN_MS = 10 * 60_000;
// Stop hooks and Codex notify land seconds after the screen settles.
const STALL_NOTE_SLACK_MS = 30_000;
const STALL_TAIL_LINES = 15;
// Claude draws one row per background agent under the limit line.
const LIMIT_TAIL_LINES = 30;
// A failed STALLED post (server restarting) tries again this often, this many times.
const STALL_RETRY_MS = 60_000;
const STALL_TRIES = 5;
const STALL_REPEAT_MS = 30 * 60_000;
const STALL_REPEATS = 2;
// A TUI repaints after a resize; that redraw is not the worker moving again.
const RESIZE_REPAINT_MS = 2_000;
// Script panes go quiet when they finish; only an agent CLI waits on its teacher.
const WORKER_CLI_RE = /(?:^|[;&|\r\n])\s*&?\s*["']?(?:[^\s"';&|]*[\\/])?(claude|codex|muse|grok|gemini|agy)(?:\.(?:exe|cmd|ps1))?["']?(?=\s|$)/i;
const AGENT_BUSY_RE = /(?:esc to interrupt|^[·✢✳✶✻✽*][\s─]+\S[^\n]*…(?:\s+\(|\s*$)|^[ \t]*[\u2800-\u28ff][\s─]+\S[^\n]*(?:…|\.{3})(?:\s+\(|\s*$))/mu;
// Claude Code's status line counts live jobs in a "·" segment; its "done ... still running" line is history and never clears.
const AGENT_JOBS_RE = /^(?!.*still running)(?=.*·)(?:.*·)?\s*(?:\d+ [^,·]+, )*\d+ (?:shells?|monitors?|local agents?)(?:, \d+ [^,·]+)*\s*(?:·|$)/u;
// Background agents stay out of that count: Claude Code lists them under its input box, and only its newest turn line, right above the box, waits on them.
const AGENTS_RUNNING_RE = /^✻ Waiting for \d+ background agents?\b.*\n+─+$(?=(?:\n(?!─+$).*)*\n─+$(?![\s\S]*^─+$))|^─+$(?![\s\S]*^─+$)[\s\S]*^\s*● main$/mu;
// Wrapping, borders, spinner glyphs and clocks change on a redraw without the worker moving; a busy agent's ticking timer still counts.
const STALL_CHURN_RE = /[\u2500-\u257f\u2800-\u28ff✻✢✳✶✽·*●]|\b\d+[hms]\b|\d{1,2}:\d{2}(?::\d{2})?|\b\d+(?:\.\d+)?%(?=\s+context left\b)/gu;
const stallSignature = (screenText) => AGENT_BUSY_RE.test(screenText) ? screenText : screenText.replace(STALL_CHURN_RE, "").replace(/\s+/g, "");
const agentJobsRunning = (screenText, shellsOnly = false) => AGENTS_RUNNING_RE.test(screenText) || screenText.split("\n").filter((line) => line.trim()).slice(-JOBS_FOOTER_LINES).some((line) => AGENT_JOBS_RE.test(line) && (!shellsOnly || /\b[1-9]\d* shells?\b/u.test(line)));
const INPUT_ECHO_LIMIT = 4_096;
const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
export const BOT_PANE_LIMIT = 16;
// Exited panes stay readable until this many terminals are open.
const SESSION_LIMIT = 32;
const MB = 1024 ** 2;
const ENGINE_MEMORY_FLOOR = { claude: 600 * MB, codex: 150 * MB, muse: 150 * MB };
const OTHER_MEMORY_FLOOR = 300 * MB;
const SHELL_MEMORY_FLOOR = 100 * MB;
const LABEL_LIMIT = 40;
const MIN_ID_PREFIX_LEN = 8;
const CLOSED_PANE_HISTORY_LIMIT = 32;
const WAIT_POLL_MS = 100;
const READ_WAIT_DEFAULT_MS = 15_000;
const READ_WAIT_MAX_MS = 60_000;
// Pre-started main shells nobody has shown yet: at most this many, each for this long.
export const PRESTART_LIMIT = 3;
export const PRESTART_IDLE_MS = 10 * 60_000;
// A stray Enter on an empty Claude prompt submits its suggestion as a real turn.
const BOT_PANE_ENV = { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" };
// STATUS_DLL_INIT_FAILED: the shell died loading, before it ran anything.
const DLL_INIT_FAILED = 0xC0000142;
const RESPAWN_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves a bot's own pane by full id or a unique prefix of at least MIN_ID_PREFIX_LEN chars. */
export function resolveBotSession(live, idOrPrefix) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Session ids cross the local proxy boundary.
  if (typeof idOrPrefix !== "string" || !idOrPrefix) return {};
  const exact = live.find((candidate) => candidate.id === idOrPrefix);
  if (exact) return { session: exact };
  if (idOrPrefix.length < MIN_ID_PREFIX_LEN) return {};
  const matches = live.filter((candidate) => candidate.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) return { ambiguous: true };
  return {};
}

const stringControl = new Set(["P", "^", "_", "X"]);

function isPrintable(char) {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export function createTerminalOutputParser(onOsc = () => {}) {
  let state = "normal";
  let osc = "";
  return {
    consume(data) {
      let text = "";
      let bell = false;
      for (const char of data) {
        if (state === "normal") {
          if (char === "\x1b") state = "escape";
          else if (char === "\x9b") state = "csi";
          else if (char === "\x9d") { state = "osc"; osc = ""; }
          else if (char === "\x07") bell = true;
          else if (isPrintable(char) || char === "\r" || char === "\n" || char === "\t") text += char;
          continue;
        }
        if (state === "escape") {
          if (char === "[") state = "csi";
          else if (char === "]") { state = "osc"; osc = ""; }
          else if (stringControl.has(char)) state = "string";
          else state = "normal";
          continue;
        }
        if (state === "csi") {
          const code = char.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) state = "normal";
          continue;
        }
        if (state === "osc") {
          if (char === "\x07") { onOsc(osc); state = "normal"; }
          else if (char === "\x1b") state = "osc-escape";
          else if (osc.length < 128) osc += char;
          continue;
        }
        if (state === "osc-escape") {
          if (char === "\\" || char === "\x07") onOsc(osc);
          state = char === "\\" ? "normal" : char === "\x07" ? "normal" : "osc";
          continue;
        }
        if (state === "string") {
          if (char === "\x1b") state = "string-escape";
          continue;
        }
        state = char === "\\" ? "normal" : "string";
      }
      return { text, bell };
    },
  };
}

function inputEchoText(data) {
  const parsed = createTerminalOutputParser().consume(data);
  return parsed.text.replace(/[\r\n\t]/g, "").slice(0, INPUT_ECHO_LIMIT);
}

function isSubmitInput(data) {
  return /[\r\n]/.test(data) || data === "\x1bOM" || data === "\x1b[27;13~" || /^\x1b\[13(?:;\d+)?u$/.test(data);
}

function normalizeTerminalText(text) {
  return text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

// Real limit screens only: Claude's line sits at the start of its gutter row, Codex's starts the "■" error block. Quoted sentences in diffs, greps and logs carry a prefix.
const CLAUDE_LIMIT_RE = /^\s*(?:⎿\s+)?You['’]ve hit your [^·\n]*limit\s*·\s*resets (\S.*)$/i;
const CODEX_LIMIT_RE = /^\s*■\s+You['’]ve hit your usage limit\..{0,400}?try again at (.+?)\.(?: |$)/i;

const LIMIT_START = { claude: /^\s*(?:⎿\s+)?You['’]ve hit your /i, codex: /^\s*■\s+You['’]ve hit your usage limit\./i };
const LIMIT_IDLE_RE = /^(?:What do you want to do\?|[❯›]?\s*\d+\. .+|Approaching rate limits|Switch to .+|Fast and affordable .+|gpt-.+|\d+(?:\.\d+)?% context left.*|⏵.*|[❯›?]|[─━]+|● Usage limit reached · .+|\/usage-credits .+|✻ \S+ for \d.+)$/u;
const CLAUDE_RESUME_RE = /^● Usage limit reached · continuing automatically at (.+?)(?: · |$)/u;

function usageLimit(screenText, engine, cols = 80) {
  const lines = screenText.split("\n").map((line) => line.trimEnd());
  const nonempty = lines.flatMap((line, i) => line ? [i] : []);
  const tail = [];
  let wrapped = false;
  for (const line of lines.slice(nonempty.at(-LIMIT_TAIL_LINES) ?? 0)) {
    if (wrapped && line && !/^\s*[●•■❯›⎿]/u.test(line)) tail[tail.length - 1] += line;
    else tail.push(line);
    wrapped = line.length === cols && !/^[─━]+$/u.test(line);
  }
  const start = tail.findLastIndex((line) => LIMIT_START[engine]?.test(line));
  if (start < 0) return null;
  const reader = engine === "claude" ? CLAUDE_LIMIT_RE : CODEX_LIMIT_RE;
  let end = start;
  let text = tail[start];
  let reset = reader.exec(text)?.[1];
  while ((!reset || (reset.includes("(") && !reset.includes(")"))) && end + 1 < tail.length) {
    const next = tail[end + 1];
    if (!next.trim() || LIMIT_IDLE_RE.test(next.trim())) break;
    text += next;
    end += 1;
    reset = reader.exec(text)?.[1];
  }
  // Claude's footer under its current input box holds notices and the user's own status line; an older box above it is history.
  const borders = tail.flatMap((line, i) => /^[─━]+$/u.test(line) && !/^[─━]+$/u.test(tail[i - 1] ?? "") ? [i] : []);
  const box = engine === "claude" && borders.at(-2) > end ? borders.at(-2) : -1;
  const after = tail.slice(end + 1, box < 0 ? undefined : box);
  if (after.some((line) => line.trim() && !LIMIT_IDLE_RE.test(line.trim()))) return null;
  reset = reset?.trim();
  const resumes = after.map((line) => CLAUDE_RESUME_RE.exec(line.trim())?.[1]).find(Boolean);
  return reset ? { engine: engine === "claude" ? "Claude" : "Codex", reset, resumes } : null;
}

// A turn that dies on a usage limit or a menu runs no engine hook, so the screen is the only signal.
function stallNoteText(screenText, stallMs, cwd, engine, cols) {
  const lines = screenText.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-STALL_TAIL_LINES);
  const limit = usageLimit(screenText, engine, cols);
  if (limit) return `LIMIT: ${limit.engine} hit its usage limit (resets ${limit.reset}). Its work so far stays in ${cwd}. ${limit.resumes ? `It resumes by itself at ${limit.resumes}.` : 'Send "continue" after the reset, or move the job to another engine.'}`;
  const tail = lines.join("\n");
  return `STALLED: no screen change for ${Math.max(1, Math.round(stallMs / 60_000))} min and no report. It may be stuck on a usage limit, a menu or an error. terminal_read its pane, then act or tell the user. Last lines:\n${tail}`;
}

// What each engine's own footer shows; Claude's appears only near its compact threshold.
const CONTEXT_RES = {
  claude: [[/\b(\d{1,3})% until auto-compact\b/, "left"], [/\bContext low \((\d{1,3})% remaining\)/, "left"], [/\b(\d{1,3})% context used\b/, "used"]],
  codex: [[/\b(\d{1,3})% context left\b/, "left"], [/\bContext (\d{1,3})% left\b/, "left"], [/\bContext (\d{1,3})% used\b/, "used"]],
};
const GROK_CONTEXT_RE = /^\s*grok-[\w.-]+ · (\d+(?:\.\d+)?)([KM])? \/ (\d+(?:\.\d+)?)([KM])\s*$/;
// The Claude worker status line's own last line, scaled to its compact window.
const CLAUDE_STATUS_RE = /^\s*ctx (\d+)k\/(\d+)k\s*$/;
const CONTEXT_FOOTER_LINES = 6;
const CONTEXT_NOTE_TOKENS = 200_000;
const CONTEXT_EARLY_SHARE = 0.8;
const CONTEXT_SAVE_LINE = "Context is getting full. Update your progress file now (done, in flight, left), then continue.";
// Both queue typed text while busy; a menu would take the Enter as a pick.
const SAVE_LINE_ENGINES = new Set(["claude", "codex"]);
const PANE_MENU_RE = /^\s*[❯›]\s*\d+\.\s/u;
const CLAUDE_COMPACTING_RE = /^[·✢✳✶✻✽*][\s─]+Compacting conversation…/mu;
const BRACKETED_PASTE_MODE = 2004;
const SAVE_ENTER_MS = 5_000;
const CLAUDE_TRUST_SETTLE_MS = 500;
const tokenCount = (value, unit) => Math.round(Number(value) * (unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1));

function codexCapacity({ screenText, cursor }) {
  const lines = screenText.split("\n");
  const prompt = lines[cursor.row] ?? "";
  if (!/^\s*›\s*$/u.test(prompt) || cursor.col !== prompt.indexOf("›") + 2
    || AGENT_BUSY_RE.test(screenText) || lines.some((line) => PANE_MENU_RE.test(line))
    || /(?:^|\n)\s*enter select · esc back\s*$/u.test(screenText)) return false;
  const before = lines.slice(0, cursor.row);
  const last = before.findLastIndex((line) => line.trim());
  let first = last;
  while (first > 0 && before[first - 1].trim()) first -= 1;
  // A soft wrap can split a word, so compare with all whitespace removed.
  const output = before.slice(first, last + 1).join("").replace(/\s+/gu, "");
  return /^(?:■)?Selectedmodelisatcapacity\.Pleasetryadifferentmodel\.$/u.test(output);
}

function claudeTrustKeys(screenText) {
  const lines = screenText.split("\n").map((line) => line.trim()).filter(Boolean);
  const text = lines.join(" ");
  if (!lines.includes("Accessing workspace:")
    || !text.includes("Quick safety check: Is this a project you created or one you trust?")
    || !text.includes("Claude Code'll be able to read, edit, and execute files here.")) return null;
  const [no, yes, footer] = lines.slice(-3);
  if (footer !== "Enter to confirm · Esc to cancel") return null;
  // No is the default; Enter alone would exit.
  if (/^[>❯] No, exit$/u.test(no) && yes === "Yes, I trust this folder") return "\x1b[B";
  if (no === "No, exit" && /^[>❯] Yes, I trust this folder$/u.test(yes)) return "\r";
  return null;
}

function paneContext(screenText, engine) {
  const lines = screenText.split("\n").filter((line) => line.trim()).slice(-CONTEXT_FOOTER_LINES).reverse();
  const status = engine === "claude" ? lines.map((line) => CLAUDE_STATUS_RE.exec(line)).find(Boolean) : null;
  if (status && Number(status[2]) > 0) {
    const tokens = Number(status[1]) * 1_000;
    const windowTokens = Number(status[2]) * 1_000;
    return { tokens, window: windowTokens, left: Math.max(0, Math.round((1 - tokens / windowTokens) * 100)) };
  }
  for (const line of lines) {
    if (engine === "grok") {
      const match = GROK_CONTEXT_RE.exec(line);
      if (!match) continue;
      const tokens = tokenCount(match[1], match[2]);
      const windowTokens = tokenCount(match[3], match[4]);
      if (windowTokens > 0 && tokens <= windowTokens) return { tokens, left: Math.round((1 - tokens / windowTokens) * 100) };
      continue;
    }
    for (const [re, kind] of CONTEXT_RES[engine] ?? []) {
      const match = re.exec(line);
      const percent = match ? Number(match[1]) : NaN;
      if (percent <= 100) return { left: kind === "left" ? percent : 100 - percent };
    }
  }
  return null;
}

const contextOver = (context) => context.window ? context.tokens >= context.window * CONTEXT_EARLY_SHARE
  : context.tokens !== undefined ? context.tokens >= CONTEXT_NOTE_TOKENS : context.left <= 50;

function contextNoteText(label, context) {
  const nick = label?.split("|")[0].trim() || "this worker";
  const used = `${100 - context.left}% of its window`;
  const size = context.window ? `${Math.round(context.tokens / 1000)}k of ${Math.round(context.window / 1000)}k`
    : context.tokens !== undefined ? `${Math.round(context.tokens / 1000)}k context (${used})` : used;
  return `CONTEXT: ${nick} is at ${size}. It could not get the save line; terminal_read the pane.`;
}

const canTakeSaveLine = (screenText, engine) => SAVE_LINE_ENGINES.has(engine) && AGENT_BUSY_RE.test(screenText)
  && !screenText.split("\n").filter((line) => line.trim()).slice(-STALL_TAIL_LINES).some((line) => PANE_MENU_RE.test(line));

function canSubmitSaveLine(screen, engine) {
  const { screenText, cursor } = screen;
  const lines = screenText.split("\n");
  if (!SAVE_LINE_ENGINES.has(engine) || lines.some((line) => PANE_MENU_RE.test(line))
    || /Allow .+\?|Do you want to (?:proceed|allow|run)|Would you like to (?:proceed|run)|\(y\/n\)|esc to cancel|enter to (?:confirm|select)/i.test(screenText)) return false;
  if (cursor.col !== lines[cursor.row]?.length) return false;
  let start = cursor.row;
  // Claude Code draws its live prompt with a no-break space, its transcript with a plain one.
  while (start > 0 && !/^\s*[>❯›]\s/u.test(lines[start])) start -= 1;
  const input = lines.slice(start, cursor.row + 1).join("").replace(/^\s*[>❯›]\s/u, "");
  return input.replace(/\s+/g, "") === CONTEXT_SAVE_LINE.replace(/\s+/g, "");
}

function finishedNoteText(screenText) {
  const tail = screenText.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-STALL_TAIL_LINES).join("\n");
  return `FINISHED: command ended without a report. terminal_read its pane, then act or tell the user. Last lines:\n${tail}`;
}

function exitNoteText(screenText, exitCode) {
  const tail = screenText.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-STALL_TAIL_LINES).join("\n");
  const text = `EXITED: pane shell ended with code ${exitCode} (0x${(exitCode >>> 0).toString(16).toUpperCase()}) before a report. terminal_read the pane list, then respawn or tell the user.`;
  return tail ? `${text} Last lines:\n${tail}` : text;
}

function commandHash(command) {
  return createHash("sha256").update(command.trim()).digest("base64");
}

// Wrap the existing reader without loading a module; Write-Error preserves a failed $? for the user's prompt.
export function workerShellArgs(id) {
  const script = `$global:OrbitPrompt = $function:prompt
$global:OrbitReadLine = $null
$global:OrbitHash = $null
function global:prompt {
  $ok = $?
  $last = Get-History -Count 1
  $last = if ($last) { $last.Id } else { 0 }
  [Console]::Write("$([char]27)]133;D;${id};$last$([char]7)")
  if (-not $global:OrbitReadLine -and $function:PSConsoleHostReadLine) {
    $global:OrbitReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $line = & $global:OrbitReadLine
      if (-not $global:OrbitHash) { $global:OrbitHash = [Security.Cryptography.SHA256]::Create() }
      $hash = [Convert]::ToBase64String($global:OrbitHash.ComputeHash([Text.Encoding]::UTF8.GetBytes(([string]$line).Trim())))
      [Console]::Write("$([char]27)]133;C;${id};$hash$([char]7)")
      $line
    }
  }
  if (-not $ok) { Write-Error '' -ErrorAction Ignore }
  & $global:OrbitPrompt
}`;
  return ["-NoLogo", "-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

// X10/RXVT (ESC [ M + 3 bytes), SGR (ESC [ < ... M/m), focus (ESC [ I/O).
// X10 trailing bytes bypass the CSI parser as printable text, so without
// this they would read as typed input.
function isMouseReport(data) {
  return /^(?:\x1b\[M[\s\S]{3}|\x1b\[<[0-9;]*[mM]|\x1b\[[IO])+$/.test(data);
}

function consumeInputEcho(text, pending) {
  if (!pending || !text.replace(/[\r\n\t]/g, "")) return { text, pending };
  let consumed = 0;
  let mismatch = false;
  const rest = [];
  for (const char of text) {
    if (consumed < pending.length && /[\r\n\t]/.test(char)) {
      rest.push(char);
      continue;
    }
    if (consumed < pending.length) {
      if (char !== pending[consumed]) mismatch = true;
      else {
        consumed += 1;
        continue;
      }
    }
    rest.push(char);
  }
  if (mismatch) return { text, pending: "" };
  if (consumed < pending.length) return { text: "", pending: pending.slice(consumed) };
  return { text: rest.join(""), pending: "" };
}

export function terminalReadyTimeoutMs(platform = process.platform) {
  return platform === "win32" ? WINDOWS_READY_TIMEOUT_MS : READY_TIMEOUT_MS;
}

export function terminalEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Environment values cross the native spawn boundary.
    typeof value === "string" && !/^(OMB_|OGB_|ORBIT_|COMMS_|ELECTRON_|NODE_OPTIONS$)/i.test(key)
      && !/(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)/i.test(key),
  ));
}

export function trustedTerminalSender(event, owner, origin) {
  if (!owner || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === origin && new URL(owner.getURL()).origin === origin;
  } catch {
    return false;
  }
}

// First command token names the pane's engine; $env:... assignments before it (agy line) do not.
function paneMemoryFloor(command) {
  if (!command || !command.trim()) return SHELL_MEMORY_FLOOR;
  const bare = command.replace(/^(?:\s*\$env:[^;]*;)+/i, "").trim();
  const m = bare.match(/^[&\s]*(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/);
  const token = m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
  const engine = token.split(/[\\/]/).pop().replace(/\.(exe|cmd|ps1)$/i, "").toLowerCase();
  return ENGINE_MEMORY_FLOOR[engine] ?? OTHER_MEMORY_FLOOR;
}

function paneLabel(value) {
  if (value === undefined || value === null) return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Labels cross the local proxy and IPC boundaries.
  if (typeof value !== "string") throw new Error("Invalid terminal label");
  return value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, LABEL_LIMIT) || undefined;
}

export function createTerminalHost({ authorize, resolveCwd, owner: paneOwner = () => null, mailbox = async () => null, loadPty = () => ({ spawn: (shell, args, options) => spawnTerminalPty(require.resolve("node-pty"), shell, args, options) }), env = process.env, platform = process.platform, readyTimeoutMs = terminalReadyTimeoutMs(platform), activityCoalesceMs = TERMINAL_ACTIVITY_COALESCE_MS, attentionCooldownMs = TERMINAL_ACTIVITY_ACK_COOLDOWN_MS, stallMs = TERMINAL_STALL_MS, stallCheckMs = STALL_CHECK_MS, prestartIdleMs = PRESTART_IDLE_MS, notePane = postPaneNote, now = () => Date.now(), freeMemory = () => os.freemem(), setPriority = os.setPriority, paneRuns = null, botNames = async () => ({}) }) {
  const sessions = new Map();
  const active = new Map();
  const generations = new Map();
  const pending = new Map();
  const paneReservations = new Map();
  const deletedBots = new Set();
  const closedBotPanes = new Map();
  let reservedPanes = 0;
  let disposed = false;
  let disposal = null;
  // conpty.node edits one unlocked process-wide pty list on every shell exit, so panes stop one at a time.
  let stopTail = null;
  const stopInTurn = (stop) => {
    const run = stopTail ? stopTail.then(stop) : stop();
    const tail = run.catch(() => {}).then(() => {
      if (stopTail === tail) stopTail = null;
    });
    stopTail = tail;
    return run;
  };
  // Retired panes whose worker thread may outlive the shell; quit waits for these too.
  const exiting = new Set();
  let stallTimer = null;
  // Panes that exited on their own with notes still to post; reclaiming them keeps the notes, a close drops them.
  const exitNotes = new Set();
  const rememberClosedPane = (botId, sessionId) => {
    const list = closedBotPanes.get(botId) ?? [];
    list.push(sessionId);
    if (list.length > CLOSED_PANE_HISTORY_LIMIT) list.shift();
    closedBotPanes.set(botId, list);
  };
  const wasClosedPane = (botId, idOrPrefix) => {
    const list = closedBotPanes.get(botId);
    if (!list) return false;
    return list.some((id) => id === idOrPrefix || (idOrPrefix.length >= MIN_ID_PREFIX_LEN && id.startsWith(idOrPrefix)));
  };
  const dimensions = (cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) {
      throw new Error("Invalid terminal dimensions");
    }
  };
  const timeout = (promise, duration, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), duration);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (cause) => { clearTimeout(timer); reject(cause); });
  });
  const errorValue = (value) => value instanceof Error ? value : new Error(String(value));
  const current = (key) => {
    const id = active.get(key);
    const session = id ? sessions.get(id) : null;
    if (!session) active.delete(key);
    return session ?? null;
  };
  const snapshot = (session) => {
    const screen = session.screen.snapshot();
    const result = {
      id: session.id,
      sessionId: session.id,
      generation: session.generation,
      cwd: session.cwd,
      shell: session.shell,
      // Trimmed history can drop a full-screen app's alt-screen switch.
      output: session.truncated && screen.alternate ? `\x1b[?1049h${session.output}` : session.output,
      exitCode: session.exitCode,
      seq: session.seq,
      ...screen,
    };
    if (session.launchProject !== undefined) result.launchProject = session.launchProject;
    if (session.label) result.label = session.label;
    return result;
  };
  const botSessions = (botId) => [...sessions.values()].filter((candidate) => candidate.botId === botId && !candidate.retired && active.get(candidate.key) === candidate.id);
  const paneSummary = (session) => ({ sessionId: session.id, generation: session.generation, label: session.label ?? null, cwd: session.cwd, main: !session.botPane, exited: session.exitCode !== null, changedAt: session.stallScreenAt });
  const owned = (event, id) => {
    authorize(event);
    const session = sessions.get(id);
    if (!session || session.owner !== event.sender || session.retired || active.get(session.key) !== id) throw new Error("Unknown terminal");
    return session;
  };
  const emit = (session, channel, value) => {
    try {
      authorize({ sender: session.owner, senderFrame: session.owner.mainFrame });
      session.owner.send(channel, value);
    } catch {}
  };
  const clearActivityTimer = (session) => {
    if (!session.activityTimer) return;
    clearTimeout(session.activityTimer);
    session.activityTimer = null;
  };
  const reportAttention = (session, reason) => {
    // A pane the bot spawned is the bot's to watch; its WAITING and STALLED notes reach the bot, not the user.
    if (session.retired || session.attentionReported || session.botPane || session.prestartedAt !== null) return false;
    session.attentionReported = true;
    session.activityArmed = false;
    emit(session, "terminal:attention", { id: session.id, botId: session.botId, reason });
    return true;
  };
  const scheduleActivity = (session) => {
    if (!session.activityArmed || session.retired || session.attentionReported || now() < session.activityCooldownUntil) return;
    // Settle-based so a redrawing TUI reports when it goes quiet, not on its first frame.
    clearActivityTimer(session);
    session.activityTimer = setTimeout(() => {
      session.activityTimer = null;
      if (session.retired || session.attentionReported || !session.activityArmed || now() < session.activityCooldownUntil) return;
      reportAttention(session, "activity");
    }, activityCoalesceMs);
    session.activityTimer.unref?.();
  };
  // An infinite retryAt holds the next try while this one is in flight.
  const postNote = (session, note, text, settle) => {
    note.tries += 1;
    note.retryAt = Infinity;
    const scope = { pane: session.id, bot: session.botId, teacher: session.teacher };
    void Promise.resolve().then(() => notePane(session.mail, scope, text)).then(() => settle(true), () => {
      note.retryAt = now() + STALL_RETRY_MS;
      if (note.tries >= STALL_TRIES) settle(false);
    });
  };
  const typeIntoPane = (session, data) => {
    void Promise.resolve().then(() => session.pty.write(data)).catch((cause) => fail(session, cause));
  };
  const submitSaveLine = (session, note) => {
    void Promise.resolve().then(() => {
      const screen = session.screen.snapshot({ maxScrollbackChars: 0 });
      if (session.retired || session.exitCode !== null || session.contextNote !== note) return;
      if (!canSubmitSaveLine(screen, session.engine)) {
        if (note.save !== "sent") note.save = "failed";
        return;
      }
      const busy = AGENT_BUSY_RE.test(screen.screenText);
      if (note.save === "sent" && (busy || note.idleSent)) return;
      note.save = "sent";
      note.idleSent = !busy;
      return session.pty.write("\r");
    }).catch((cause) => fail(session, cause));
  };
  const postAuto = (session, auto) => postNote(session, auto, auto.text, (delivered) => {
    if (delivered) session.noteAt = now();
    if (session.autoNote !== auto) return;
    session.autoNote = null;
    session.autoDelivered = delivered;
  });
  const checkStalls = () => {
    const at = now();
    for (const session of new Set([...sessions.values(), ...exitNotes])) {
      const exited = exitNotes.has(session);
      if ((session.retired || session.exitCode !== null) && !exited) continue;
      if (!session.mail) session.finished = [];
      for (const finished of session.finished) {
        if (at < finished.retryAt) continue;
        postNote(session, finished, finishedNoteText(finished.text), () => { session.finished = session.finished.filter((entry) => entry !== finished); });
      }
      const exitNote = session.exitNote;
      if (exitNote && at >= exitNote.retryAt) postNote(session, exitNote, exitNote.text, () => { session.exitNote = null; });
      const auto = session.autoNote;
      // Once tried, or once its pane is gone, the busy and job checks no longer apply.
      if (auto && (auto.tries || exited)) {
        if (!session.mail) session.autoNote = null;
        else if (at >= auto.retryAt) postAuto(session, auto);
      } else if (auto && at - auto.at >= TERMINAL_TURN_END_MS) {
        const text = session.screen.text();
        const busy = AGENT_BUSY_RE.test(text);
        if (!busy && at - auto.at < JOBS_HOLD_MS && agentJobsRunning(text)) auto.jobsAt = at;
        else if (busy || !auto.jobsAt || at - auto.jobsAt >= JOBS_QUIET_MS || at - auto.at >= JOBS_HOLD_MS) {
          if (busy || !session.mail) session.autoNote = null;
          else postAuto(session, auto);
        }
      }
      if (exited) {
        if (!session.autoNote && !session.finished.length && !session.exitNote) exitNotes.delete(session);
        continue;
      }
      if (!session.worker || session.retired || session.exitCode !== null) continue;
      if (session.engine === "claude" && session.compactSignal && fs.existsSync(session.compactSignal)) {
        try {
          fs.unlinkSync(session.compactSignal);
          session.contextCompactPending = true;
        } catch {}
      }
      const text = session.screen.text();
      const context = paneContext(text, session.engine);
      // The compact hook can run before Claude clears its old low-context footer.
      if (session.contextCompactPending && (!context || !contextOver(context))) {
        session.contextCompactPending = false;
        session.contextNote = null;
      }
      // A compaction back under the line re-arms the note.
      if (context && !contextOver(context)) session.contextNote = null;
      // Claude's spinner counts as busy, but its own compaction needs no save line.
      else if (!session.contextCompactPending && context && !(session.engine === "claude" && CLAUDE_COMPACTING_RE.test(text))) {
        const note = session.contextNote ??= { tries: 0, retryAt: 0, save: null, typedAt: 0 };
        if (!note.save) {
          // A compaction re-arms the note while the last save line can still sit unsent in the input.
          const queued = canSubmitSaveLine(session.screen.snapshot({ maxScrollbackChars: 0 }), session.engine);
          note.save = queued || canTakeSaveLine(text, session.engine) ? "typed" : "failed";
          if (queued) note.typedAt = at;
          else if (note.save === "typed") {
            const paste = session.screen.snapshot({ maxScreenChars: 1, maxScrollbackChars: 0 }).modes?.includes(BRACKETED_PASTE_MODE);
            note.typedAt = at;
            session.pendingInputEcho = `${session.pendingInputEcho}${CONTEXT_SAVE_LINE}`.slice(-INPUT_ECHO_LIMIT);
            typeIntoPane(session, paste ? `\x1b[200~${CONTEXT_SAVE_LINE}\x1b[201~` : CONTEXT_SAVE_LINE);
          }
        } else if (note.typedAt && at - note.typedAt >= SAVE_ENTER_MS && !note.idleSent
          && (note.save === "typed" || !AGENT_BUSY_RE.test(text))) {
          // Text plus Enter in one write can land in Claude Code as a paste that never submits.
          submitSaveLine(session, note);
        }
        if (note.save === "failed" && session.mail && at >= note.retryAt) {
          // The pane receipt can arrive even when the HTTP response is lost.
          if (note.tries && session.noteAt > note.attendedAt) note.retryAt = Infinity;
          else {
            note.attendedAt = session.noteAt;
            postNote(session, note, contextNoteText(session.label, context), () => { note.retryAt = Infinity; });
          }
        }
      }
      const limit = usageLimit(text, session.engine, session.cols);
      const limitKey = limit ? JSON.stringify([session.engine, limit.reset.replace(/\s+/g, "")]) : null;
      if (session.stallDirty) {
        session.stallDirty = false;
        const signature = limitKey ?? stallSignature(text);
        if (signature !== session.stallText) {
          session.stallText = signature;
          session.stallChangedAt = at;
          session.stallScreenAt = at;
          session.stallFired = false;
          session.stallTries = 0;
          session.stallPosts = 0;
          session.stallRepeatAt = Infinity;
        }
      }
      const capacity = session.engine === "codex" && codexCapacity(session.screen.snapshot({ maxScrollbackChars: 0 }));
      const threshold = capacity ? CODEX_CAPACITY_WAIT_MS : !limit && (!session.agentSeen || session.engine === "claude" && agentJobsRunning(text, true)) ? JOBS_HOLD_MS : stallMs;
      if (session.stallFired && (limit || capacity || AGENT_BUSY_RE.test(text) || session.stallPosts > STALL_REPEATS || at <= session.stallRepeatAt)) continue;
      if (at - session.stallChangedAt < threshold || at < session.stallRetryAt) continue;
      // Typed input can sit in the PTY before the screen echoes it
      if (capacity && session.userInputAt < session.stallChangedAt && session.stallChangedAt - session.capacityContinuedAt >= CODEX_CAPACITY_COOLDOWN_MS) {
        session.capacityContinuedAt = at;
        session.stallFired = true;
        typeIntoPane(session, "continue\r");
        session.stallText = null;
        continue;
      }
      if (limitKey && session.limitsNoted.has(limitKey)) continue;
      // Its report on this task, or a hook note on this task as the screen settled, already reached the teacher.
      if (session.reportAt >= session.stallArmedAt) continue;
      if (session.noteAt >= session.stallArmedAt && session.noteAt >= session.stallChangedAt - STALL_NOTE_SLACK_MS) continue;
      if (session.stallFired) session.stallTries = 0;
      session.stallFired = true;
      session.stallRepeatAt = Infinity;
      if (!session.mail) continue;
      if (limitKey) session.limitsNoted.add(limitKey);
      const scope = { pane: session.id, bot: session.botId, teacher: session.teacher };
      const stall = session.stallChangedAt;
      session.stallTries += 1;
      const elapsed = session.stallPosts ? at - stall : threshold;
      const sentAt = now();
      const delivered = () => {
        if (session.stallChangedAt !== stall) return;
        session.stallPosts += 1;
        session.stallRepeatAt = now() + STALL_REPEAT_MS * 2 ** (session.stallPosts - 1);
      };
      void Promise.resolve().then(() => notePane(session.mail, scope, stallNoteText(text, elapsed, session.cwd, session.engine, session.cols))).then(delivered).catch(() => {
        // The mailbox can store the note and send its receipt even when the response is lost.
        if (session.stallReceiptAt >= sentAt) return delivered();
        if (limitKey) session.limitsNoted.delete(limitKey);
        // A LIMIT receipt raises noteAt, which stops the retry above.
        if (session.stallChangedAt !== stall || session.stallTries >= STALL_TRIES) return;
        session.stallFired = false;
        session.stallRetryAt = now() + STALL_RETRY_MS;
      });
    }
  };
  const watchNotes = () => {
    if (stallTimer || disposed) return;
    stallTimer = setInterval(checkStalls, stallCheckMs);
    stallTimer.unref?.();
  };
  const watchStalls = (session) => {
    session.worker = true;
    watchNotes();
  };
  const resolveFolder = async (input, event) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Optional session-only override from an explicit folder pick.
    if (typeof input.cwd === "string" && input.cwd.trim()) return { cwd: input.cwd.trim() };
    const resolved = await resolveCwd(input.botId, event);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminated folder resolution may ask the UI to choose.
    if (resolved && typeof resolved === "object" && resolved.needsFolder === true) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the server's optional folder resolution reason.
      return { needsFolder: true, reason: typeof resolved.reason === "string" ? resolved.reason : "choose-folder" };
    }
    // Server returns { cwd, source }; older stubs may still return a path string.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Normalize server and test stub shapes.
    const cwd = typeof resolved === "string" ? resolved : resolved?.cwd;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the server's project/workspace distinction as metadata.
    const source = resolved && typeof resolved === "object" ? resolved.source : undefined;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The mailbox teacher rides the folder resolution.
    const teacher = resolved && typeof resolved === "object" && typeof resolved.teacherId === "string" && BOT_ID_RE.test(resolved.teacherId) ? resolved.teacherId : undefined;
    return { cwd, source, teacher };
  };
  const launchProject = (input, folder, cwd) => {
    if (Object.prototype.hasOwnProperty.call(input, "projectCwd")) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Project selection is renderer metadata, never a spawn path.
      if (input.projectCwd !== null && typeof input.projectCwd !== "string") throw new Error("Invalid terminal project folder");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Normalize the optional project metadata before storing it.
      return typeof input.projectCwd === "string" ? input.projectCwd.trim() || null : null;
    }
    return folder.source === "project" ? cwd : undefined;
  };
  const retire = async (session, forceKill = false, keepNotes = false) => {
    if (!keepNotes) exitNotes.delete(session);
    if (session.retired && session.stopPromise) return session.stopPromise;
    const wasRetired = session.retired;
    session.retired = true;
    clearActivityTimer(session);
    clearTimeout(session.claudeTrustTimer);
    if (active.get(session.key) === session.id) active.delete(session.key);
    if (!wasRetired) emit(session, "terminal:closed", { id: session.id, botId: session.botId });
    const exited = session.pty.exited;
    if (exited) {
      exiting.add(exited);
      const drop = () => exiting.delete(exited);
      Promise.resolve(exited).then(drop, drop);
    }
    session.stopPromise = (async () => {
      if (forceKill || session.exitCode === null) {
        try {
          if (!session.workerReady) {
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may expose readiness only when worker-backed.
            const ptyReady = session.pty.ready;
            if (ptyReady && typeof ptyReady.then === "function") {
              try { await timeout(ptyReady, disposed ? QUIT_PANE_MS : readyTimeoutMs, "Terminal worker did not become ready"); } catch {}
            }
            session.workerReady = true;
          }
          await stopInTurn(async () => {
            const result = session.pty.kill();
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
            if (result && typeof result.then === "function") await timeout(result, disposed ? QUIT_PANE_MS : SHUTDOWN_TIMEOUT_MS, "Terminal shutdown timed out");
          });
        } catch {
          // Quit waits for the worker instead: terminating it under a live ConPTY aborts the process.
          if (!disposed) {
            try { session.pty.terminate?.(); } catch {}
          }
        }
      }
      if (session.compactSignal) { try { fs.unlinkSync(session.compactSignal); } catch {} }
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    })();
    return session.stopPromise;
  };
  const retireQuietly = (session, forceKill = false, keepNotes = false) => {
    void retire(session, forceKill, keepNotes).catch(() => {});
  };
  const reclaimExited = () => {
    for (const [id, session] of sessions) {
      if (session.exitCode !== null || session.owner.isDestroyed?.()) {
        active.delete(session.key);
        sessions.delete(id);
        retireQuietly(session, true, true);
      }
    }
  };
  const openTerminals = (names) => {
    const panes = new Map();
    let main = 0;
    for (const id of active.values()) {
      const session = sessions.get(id);
      if (!session || session.exitCode !== null) continue;
      if (session.botPane) panes.set(session.botId, (panes.get(session.botId) ?? 0) + 1);
      else main += 1;
    }
    const open = [...panes].sort((a, b) => b[1] - a[1]).map(([botId, count]) => `${names[botId] || botId} ${count}`);
    if (main) open.push(`main ${main}`);
    return open.length ? ` Open: ${open.join(", ")}.` : "";
  };
  const reportExit = (session, exitCode) => {
    if (session.retired) return;
    if (session.botPane && !session.respawned && exitCode >>> 0 === DLL_INIT_FAILED && now() - session.startedAt < RESPAWN_MS && !session.screen.text().trim()) {
      void respawn(session, exitCode);
      return;
    }
    if (session.botPane) paneRuns?.ended(session.id);
    if (session.exitCode === null) {
      session.exitCode = exitCode;
      if (session.botPane && session.mail && exitCode !== 0 && !(session.reportAt && session.reportAt >= session.stallArmedAt)) session.exitNote = { text: exitNoteText(session.screen.text(), exitCode), tries: 0, retryAt: 0 };
    }
    if (session.autoNote || session.finished.length || session.exitNote) exitNotes.add(session);
    clearActivityTimer(session);
    session.activityArmed = false;
    reportAttention(session, exitCode === 0 ? "exit" : "error");
    if (!session.exitReported) {
      session.exitReported = true;
      emit(session, "terminal:exit", { id: session.id, exitCode: session.exitCode });
    }
    if (session.retired && sessions.get(session.id) === session) sessions.delete(session.id);
  };
  const fail = (session, cause) => {
    if (session.retired) return;
    const error = errorValue(cause);
    session.failure = error;
    reportAttention(session, "error");
    if (!session.errorReported) {
      session.errorReported = true;
      emit(session, "terminal:error", { id: session.id, message: error.message });
    }
    reportExit(session, 1);
    retireQuietly(session, true, true);
  };
  const attach = (session) => {
    const { pty } = session;
    pty.onData((data) => {
      if (session.retired || session.pty !== pty) return;
      session.output += data;
      if (session.output.length > OUTPUT_LIMIT) {
        session.output = session.output.slice(-OUTPUT_LIMIT);
        session.truncated = true;
      }
      let parsed = { text: "", bell: false };
      try {
        parsed = session.outputParser.consume(data);
      } catch {}
      try {
        session.screen.consume(data);
      } catch {}
      clearTimeout(session.claudeTrustTimer);
      if (session.worker && session.exitCode === null && session.botPane && session.claudeTrust && !session.claudeTrustAnswered) {
        const keys = claudeTrustKeys(session.screen.text());
        if (keys && (keys === "\r" || !session.claudeTrustMoved)) {
          // Startup can redraw No after the first menu frame.
          session.claudeTrustTimer = setTimeout(() => {
            session.claudeTrustTimer = null;
            if (session.retired || session.pty !== pty || !session.worker || session.exitCode !== null
              || !session.claudeTrust || session.claudeTrustAnswered || claudeTrustKeys(session.screen.text()) !== keys) return;
            if (keys === "\r") session.claudeTrustAnswered = true;
            else session.claudeTrustMoved = true;
            typeIntoPane(session, keys);
          }, CLAUDE_TRUST_SETTLE_MS);
          session.claudeTrustTimer.unref?.();
        }
      }
      if (session.worker && !session.agentSeen) {
        const chunk = parsed.text.replace(/\s+/g, "");
        const output = chunk.includes(session.agentCommand) ? chunk : session.screen.text().replace(/\s+/g, "");
        const start = output.lastIndexOf(session.agentCommand);
        if (start !== -1) {
          session.agentEchoed = true;
          session.agentSeen = output.length > start + session.agentCommand.length;
        } else if (session.agentEchoed && parsed.text.trim()) session.agentSeen = true;
      }
      for (const finished of session.finished) if (finished.text === null) finished.text = session.screen.text();
      if (now() - session.resizedAt >= RESIZE_REPAINT_MS) {
        const busy = AGENT_BUSY_RE.test(session.screen.text());
        if (busy) {
          // Past the trust menu, so stop scanning every chunk for it.
          session.claudeTrustAnswered = true;
          session.autoNote = null;
          if (!session.agentBusy) {
            session.autoDelivered = false;
            session.autoReported = false;
          }
        }
        session.agentBusy = busy;
      }
      if (session.worker && now() - session.resizedAt >= RESIZE_REPAINT_MS) session.stallDirty = true;
      const echo = consumeInputEcho(parsed.text, session.pendingInputEcho);
      session.pendingInputEcho = echo.pending;
      if (parsed.bell && session.activityArmed) reportAttention(session, "bell");
      if (!parsed.bell && echo.text.trim()) scheduleActivity(session);
      emit(session, "terminal:data", { id: session.id, data, seq: ++session.seq });
    });
    pty.onExit(({ exitCode }) => { if (session.pty === pty) reportExit(session, exitCode); });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The test adapter predates worker error events.
    if (typeof pty.onError === "function") pty.onError((error) => { if (session.pty === pty) fail(session, error); });
  };
  const stopReplacement = (pty) => {
    if (pty.exited) {
      exiting.add(pty.exited);
      const drop = () => exiting.delete(pty.exited);
      Promise.resolve(pty.exited).then(drop, drop);
    }
    void stopInTurn(async () => {
      const result = pty.kill();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
      if (result && typeof result.then === "function") await timeout(result, disposed ? QUIT_PANE_MS : SHUTDOWN_TIMEOUT_MS, "Terminal shutdown timed out");
    }).catch(() => {
      if (!disposed) {
        try { pty.terminate?.(); } catch {}
      }
    });
  };
  // Writes that land mid-respawn wait for the new shell.
  const respawn = async (session, exitCode) => {
    session.respawned = true;
    session.respawn = [];
    let pty;
    let replacementExit = null;
    try {
      pty = await session.spawn();
      pty.onExit(({ exitCode: code }) => { replacementExit ??= code; });
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may expose readiness only when worker-backed.
      if (pty.ready && typeof pty.ready.then === "function") await timeout(pty.ready, readyTimeoutMs, "Terminal worker did not become ready");
    } catch {
      session.respawn = null;
      if (pty) stopReplacement(pty);
      if (session.retired) paneRuns?.ended(session.id);
      reportExit(session, replacementExit ?? exitCode);
      return;
    }
    const queued = session.respawn;
    session.respawn = null;
    if (session.retired) {
      paneRuns?.ended(session.id);
      stopReplacement(pty);
      return;
    }
    session.pty = pty;
    attach(session);
    if (Number.isInteger(pty.pid)) {
      try { setPriority(pty.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    }
    for (const text of session.command && !queued.includes(session.command) ? [session.command, ...queued] : queued) typeIntoPane(session, text);
  };
  const start = async ({ key, event, input, folder, cwd, cancelPromise, botPane = false }) => {
    const shell = platform === "win32"
      ? [path.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((file) => fs.existsSync(file))
      : (env.SHELL || "/bin/sh");
    if (!shell) throw new Error("No terminal shell is available");
    const id = randomUUID();
    // A pane without orbit-msg beats no pane at all.
    const mail = await Promise.resolve().then(mailbox).catch(() => null);
    const paneEnv = terminalPaneEnv(terminalEnvironment(env), { pane: id, bot: input.botId, teacher: folder.teacher, mailbox: mail });
    if (botPane) Object.assign(paneEnv, BOT_PANE_ENV, { ORBIT_COMPACT_SIGNAL: path.join(os.tmpdir(), `orbit-compact-${id}`) });
    const spawn = () => loadPty().spawn(shell, platform === "win32" ? (botPane ? workerShellArgs(id) : ["-NoLogo"]) : [], {
      name: "xterm-256color", cols: input.cols, rows: input.rows, cwd, env: paneEnv, useConptyDll: platform === "win32",
    });
    let pty;
    try {
      pty = await spawn();
    } catch (cause) {
      throw errorValue(cause);
    }
    const session = {
      id, key, botId: input.botId, botPane, owner: event.sender, cwd, shell, pty, spawn, startedAt: now(), respawned: false, respawn: null, command: null, output: "", exitCode: null, seq: 0,
      launchProject: launchProject(input, folder, cwd), retired: false, exitReported: false, errorReported: false,
      failure: null, attentionReported: false, activityArmed: false, activityCooldownUntil: 0, activityTimer: null,
      outputParser: createTerminalOutputParser(), screen: createTerminalScreen({ cols: input.cols, rows: input.rows }), cols: input.cols ?? 80, pendingInputEcho: "", truncated: false,
      workerReady: false, mail, compactSignal: paneEnv.ORBIT_COMPACT_SIGNAL ?? null, teacher: folder.teacher ?? input.botId, worker: false, engine: null, stallArmedAt: 0, stallChangedAt: 0, stallScreenAt: 0, stallText: null,
      stallDirty: false, stallFired: false, stallTries: 0, stallRetryAt: 0, stallPosts: 0, stallRepeatAt: Infinity, stallReceiptAt: -Infinity, capacityContinuedAt: -Infinity, userInputAt: -Infinity, limitsNoted: new Set(), resizedAt: -Infinity, reportAt: 0, noteAt: 0, prestartedAt: null,
      commandInputs: [], commandInput: "", commandUserInput: false, runningCommand: null, shellExecuting: false, historyId: null, finished: [], exitNote: null, autoNote: null, autoDelivered: false, autoReported: false, agentBusy: false, agentSeen: false, contextNote: null, contextCompactPending: false,
      claudeTrust: false, claudeTrustMoved: false, claudeTrustAnswered: false, claudeTrustTimer: null,
    };
    session.outputParser = createTerminalOutputParser((osc) => {
      if (!session.botPane) return;
      const [kind, markerId, value] = osc.startsWith("133;") ? osc.slice(4).split(";") : [];
      if (markerId !== session.id) return;
      if (kind === "C" && /^[A-Za-z0-9+/]{43}=$/.test(value)) {
        session.shellExecuting = true;
        // Input consumed by a program never reaches the shell's reader.
        const index = session.commandInputs.findIndex((command) => command.hash === value);
        session.runningCommand = index !== -1 ? session.commandInputs.splice(0, index + 1).at(-1) : null;
        if (session.commandUserInput) session.runningCommand = null;
        session.commandUserInput = false;
        return;
      }
      if (kind !== "D" || !/^\d+$/.test(value)) return;
      if (session.shellExecuting) {
        session.worker = false;
        paneRuns?.ended(session.id);
        session.autoNote = null;
        session.autoDelivered = true;
      }
      session.shellExecuting = false;
      const command = session.runningCommand;
      if (session.historyId !== null && value !== session.historyId && command && !command.reported) session.finished.push({ text: null, tries: 0, retryAt: 0 });
      session.historyId = value;
      session.runningCommand = null;
      session.commandInput = "";
      session.commandUserInput = false;
    });
    if (botPane) watchNotes();
    session.generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, session.generation);
    sessions.set(session.id, session);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Electron sender mocks may omit lifecycle events.
    if (typeof event.sender.once === "function") {
      event.sender.once("destroyed", () => { retireQuietly(session, true); });
    }
    attach(session);
    try {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may expose readiness only when worker-backed.
      const ready = pty.ready && typeof pty.ready.then === "function"
        ? timeout(pty.ready, readyTimeoutMs, "Terminal worker did not become ready")
        : Promise.resolve();
      // ConPTY aborts the whole process if we kill/terminate the worker during
      // spawn. Always wait for ready (or ready failure) before retiring.
      await ready;
      session.workerReady = true;
      // Workers yield a busy CPU to Wink; children inherit the class.
      if (botPane && Number.isInteger(pty.pid)) {
        try { setPriority(pty.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
      }
      if (session.failure) throw session.failure;
      let cancelled = false;
      await Promise.race([
        cancelPromise.then(() => { cancelled = true; }),
        Promise.resolve(),
      ]);
      if (cancelled) throw new Error("Terminal open cancelled");
      return session;
    } catch (cause) {
      await retire(session, true);
      throw errorValue(cause);
    }
  };
  const botWrite = (session, raw) => {
    const text = normalizeTerminalText(raw);
    clearActivityTimer(session);
    const echo = inputEchoText(text);
    const submit = isSubmitInput(text);
    const commands = `${session.commandInput}${text}`.split("\r");
    if (submit && !text.includes("\r")) commands.push("");
    session.commandInput = commands.pop().slice(-INPUT_ECHO_LIMIT);
    for (const command of commands) {
      if (command.trim()) session.commandInputs.push({ hash: commandHash(command), reported: false });
    }
    // only a command the user typed arms their alert
    if (submit) {
      clearTimeout(session.claudeTrustTimer);
      session.autoNote = null;
      session.autoDelivered = false;
      session.autoReported = false;
      session.attentionReported = false;
      session.activityCooldownUntil = 0;
      session.stallArmedAt = now();
      session.stallChangedAt = session.stallArmedAt;
      const launched = session.botPane ? WORKER_CLI_RE.exec(text) : null;
      if (launched) {
        session.engine = launched[1].toLowerCase();
        const args = text.slice(launched.index + launched[0].length).match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
        session.claudeTrust = session.engine === "claude" && args.includes("--dangerously-skip-permissions");
        session.claudeTrustMoved = false;
        session.claudeTrustAnswered = false;
        session.agentSeen = false;
        session.agentEchoed = false;
        session.agentCommand = text.replace(/\s+/g, "");
        session.contextNote = null;
        session.contextCompactPending = false;
        watchStalls(session);
      }
      if (session.botPane) paneRuns?.started({ id: session.id, botId: session.botId, teacher: session.teacher, label: session.label, cwd: session.cwd, spawnedAt: session.spawnedAt });
    }
    if (echo) session.pendingInputEcho = `${session.pendingInputEcho}${echo}`.slice(-INPUT_ECHO_LIMIT);
    if (session.respawn) {
      session.respawn.push(text);
      return undefined;
    }
    try {
      return session.pty.write(text);
    } catch (cause) {
      fail(session, cause);
      throw cause;
    }
  };
  const runOpen = async (operation) => {
    let input = operation.input;
    let folder = await resolveFolder(input, operation.event);
    if (operation.cancelled) throw new Error("Terminal open cancelled");
    if (operation.restartInput && operation.restartInput !== input) {
      input = operation.restartInput;
      folder = await resolveFolder(input, operation.event);
      if (operation.cancelled) throw new Error("Terminal open cancelled");
    }
    if (folder.needsFolder) return { needsFolder: true, reason: folder.reason };
    if (!operation.trusted) authorize(operation.event);
    if (disposed) throw new Error("Terminal host is shutting down");
    const cwd = folder.cwd;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the API or picked folder before spawning.
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await fs.promises.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
      throw new Error("Terminal folder is unavailable");
    }
    if (operation.cancelled) throw new Error("Terminal open cancelled");
    const replacement = await start({ key: operation.key, event: operation.event, input, folder, cwd, cancelPromise: operation.cancelPromise });
    if (operation.cancelled) {
      await retire(replacement, true);
      throw new Error("Terminal open cancelled");
    }
    if (disposed) {
      await retire(replacement, true);
      throw new Error("Terminal host is shutting down");
    }
    active.set(operation.key, replacement.id);
    if (operation.existing && operation.existing !== replacement) retireQuietly(operation.existing);
    if (operation.prestart && !operation.claimed) holdPrestarted(replacement);
    return snapshot(replacement);
  };
  const holdPrestarted = (session) => {
    session.prestartedAt = now();
    const timer = setTimeout(() => {
      if (session.prestartedAt !== null) retireQuietly(session, true);
    }, prestartIdleMs);
    timer.unref?.();
  };
  const unshownPrestarts = () => [...sessions.values()].filter((session) => session.prestartedAt !== null && !session.retired && active.get(session.key) === session.id);
  const openMain = async (event, input, { prestart = false, trusted = false } = {}) => {
    if (disposed) throw new Error("Terminal host is shutting down");
    const key = `${event.sender.id}:${input.botId}`;
    while (true) {
      const inFlight = pending.get(key);
      if (!inFlight) break;
      if (inFlight.cancelled) {
        try { await inFlight.promise; } catch {}
        continue;
      }
      if (prestart) return null;
      inFlight.claimed = true;
      if (input.restart === true) {
        inFlight.restartInput = input;
      }
      return inFlight.promise;
    }
    const existing = current(key);
    if (existing && prestart) return null;
    if (existing && input.restart !== true) {
      existing.prestartedAt = null;
      const { cols, rows, alternate } = existing.screen.snapshot();
      // Diff-rendering TUIs cannot be rebuilt from trimmed history; a size bounce forces a full repaint.
      if (existing.truncated && alternate && existing.exitCode === null && rows > 1) {
        try {
          void Promise.resolve(existing.pty.resize(cols, rows - 1)).catch(() => {});
          void Promise.resolve(existing.pty.resize(cols, rows)).catch(() => {});
        } catch {}
      }
      return snapshot(existing);
    }
    if (prestart) {
      // The oldest never-shown shell makes room for the chat the user is on now.
      const unshown = unshownPrestarts().sort((a, b) => a.prestartedAt - b.prestartedAt);
      const evicted = unshown.slice(0, Math.max(0, unshown.length - PRESTART_LIMIT + 1));
      if (evicted.length) {
        await Promise.all(evicted.map((session) => retire(session, true)));
        if (disposed || pending.has(key) || current(key)) return null;
      }
    }
    if (!existing && active.size + reservedPanes >= SESSION_LIMIT) reclaimExited();
    let cancelResolve;
    const cancelPromise = new Promise((resolve) => { cancelResolve = resolve; });
    const operation = { key, event, input, existing, restartInput: input.restart === true ? input : null, cancelled: false, cancelPromise, cancelResolve, promise: null, prestart, trusted, claimed: false };
    operation.promise = runOpen(operation);
    pending.set(key, operation);
    try {
      return await operation.promise;
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  };
  return {
    async open(event, input) {
      authorize(event);
      if (disposed) throw new Error("Terminal host is shutting down");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC input must be validated before resolving a shell folder.
      if (!input || typeof input.botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.botId)) throw new Error("Invalid bot");
      dimensions(input.cols, input.rows);
      if (input.sessionId !== undefined) {
        const session = sessions.get(input.sessionId);
        if (!session?.botPane || session.botId !== input.botId || session.owner !== event.sender || session.retired || active.get(session.key) !== session.id) throw new Error("Unknown terminal");
        return snapshot(session);
      }
      return openMain(event, input);
    },
    /** Starts the bot's main shell before its panel is shown; the panel's open attaches to it. */
    async prestart(event, input) {
      authorize(event);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC input must be validated before resolving a shell folder.
      if (!input || typeof input.botId !== "string" || !BOT_ID_RE.test(input.botId)) throw new Error("Invalid bot");
      dimensions(input.cols, input.rows);
      const main = { botId: input.botId, cols: input.cols, rows: input.rows };
      if (input.projectCwd !== undefined) main.projectCwd = input.projectCwd;
      const result = await openMain(event, main, { prestart: true });
      return Boolean(result && !result.needsFolder);
    },
    cancelOpen(event, botId) {
      authorize(event);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC bot ids cross the untyped preload boundary.
      if (typeof botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw new Error("Invalid bot");
      const key = `${event.sender.id}:${botId}`;
      const operation = pending.get(key);
      // A pre-start belongs to no panel, so a panel unmounting cannot cancel it.
      if (!operation || (operation.prestart && !operation.claimed)) return false;
      operation.cancelled = true;
      operation.cancelResolve();
      return true;
    },
    write(event, id, data) {
      const session = owned(event, id);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-text IPC payloads before passing them to the PTY.
      if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid terminal input");
      if (session.exitCode !== null) throw new Error("Terminal has exited");
      const mouse = isMouseReport(data);
      const echo = mouse ? "" : inputEchoText(data);
      const submit = mouse ? false : isSubmitInput(data);
      // Mouse and focus reports from a TUI are not the user taking over.
      if (echo || submit) {
        if (session.botPane && !session.runningCommand) session.commandUserInput = true;
        clearActivityTimer(session);
        session.userInputAt = now();
      }
      if (submit) session.activityArmed = true;
      if (echo) session.pendingInputEcho = `${session.pendingInputEcho}${echo}`.slice(-INPUT_ECHO_LIMIT);
      // A shell can emit a bell more than once; arm the next command after Enter.
      if (submit) {
        session.autoNote = null;
        session.autoDelivered = false;
        session.autoReported = false;
        session.attentionReported = false;
        session.activityCooldownUntil = 0;
      }
      // X10 bytes past column/row 95 exceed 0x7F; a UTF-8 string write
      // would expand them to two bytes, so send the raw binary instead.
      const payload = mouse && data.includes("\x1b[M") ? Buffer.from(data, "binary") : data;
      if (session.respawn) {
        if (!mouse) session.respawn.push(data);
        return undefined;
      }
      try {
        const result = session.pty.write(payload);
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
        return result && typeof result.then === "function" ? result.catch((cause) => { fail(session, cause); throw cause; }) : result;
      } catch (cause) {
        fail(session, cause);
        throw cause;
      }
    },
    acknowledge(event, id) {
      const session = owned(event, id);
      clearActivityTimer(session);
      session.attentionReported = false;
      session.activityArmed = false;
      session.activityCooldownUntil = now() + attentionCooldownMs;
    },
    resize(event, id, cols, rows) {
      const session = owned(event, id);
      dimensions(cols, rows);
      if (session.exitCode !== null) return undefined;
      session.resizedAt = now();
      try {
        const result = session.pty.resize(cols, rows);
        session.screen.resize(cols, rows);
        session.cols = cols;
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
        return result && typeof result.then === "function" ? result.catch((cause) => { fail(session, cause); throw cause; }) : result;
      } catch (cause) {
        fail(session, cause);
        throw cause;
      }
    },
    read(event, id, options = {}) {
      const session = owned(event, id);
      const maxScreenChars = Number.isInteger(options.maxScreenChars) ? Math.max(1, Math.min(options.maxScreenChars, 64 * 1024)) : 64 * 1024;
      const maxScrollbackChars = Number.isInteger(options.maxScrollbackChars) ? Math.max(0, Math.min(options.maxScrollbackChars, 16 * 1024)) : 16 * 1024;
      const screen = session.screen.snapshot({ maxScreenChars, maxScrollbackChars });
      return {
        botId: session.botId,
        sessionId: session.id,
        generation: session.generation,
        cwd: session.cwd,
        seq: session.seq,
        capturedAt: now(),
        exitCode: session.exitCode,
        exited: session.exitCode !== null,
        ...screen,
      };
    },
    readBot(botId, options = {}) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      const buildSnapshot = () => {
        const live = botSessions(botId);
        // A user close or app quit never lands here, so notes from those panes still wake the bot.
        const closedPanes = [...(closedBotPanes.get(botId) ?? [])];
        if (options.panesOnly) return { botId, ...(live.length ? {} : { state: "no-terminal" }), capturedAt: now(), panes: live.map(paneSummary), closedPanes };
        let session;
        if (options.sessionId) {
          const match = resolveBotSession(live, options.sessionId);
          if (!match.session) throw new Error("Unknown terminal");
          session = match.session;
        } else {
          session = live.find((candidate) => !candidate.botPane) ?? live[0];
        }
        if (!session) return { botId, state: "no-terminal", screenText: "", recentText: "", seq: 0, capturedAt: now(), exitCode: null, exited: false, truncated: false, panes: [], closedPanes };
        const maxScreenChars = Number.isInteger(options.maxScreenChars) ? Math.max(1, Math.min(options.maxScreenChars, 64 * 1024)) : 64 * 1024;
        const maxScrollbackChars = Number.isInteger(options.maxScrollbackChars) ? Math.max(0, Math.min(options.maxScrollbackChars, 16 * 1024)) : 16 * 1024;
        if (options.observe) session.finished = [];
        return {
          botId,
          sessionId: session.id,
          generation: session.generation,
          label: session.label ?? null,
          cwd: session.cwd,
          seq: session.seq,
          capturedAt: now(),
          exitCode: session.exitCode,
          exited: session.exitCode !== null,
          ...session.screen.snapshot({ maxScreenChars, maxScrollbackChars }),
          panes: live.map((pane) => {
            const screenText = pane.screen.text();
            const entry = { ...paneSummary(pane), screenText };
            const context = pane.botPane ? paneContext(screenText, pane.engine) : null;
            if (context) entry.context = context;
            return entry;
          }),
          closedPanes,
        };
      };
      const first = buildSnapshot();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Wait text is untyped proxy input.
      const waitFor = typeof options.waitFor === "string" && options.waitFor ? options.waitFor : null;
      if (!waitFor || options.panesOnly) return first;
      if (first.screenText.includes(waitFor)) return Promise.resolve({ ...first, waited: "hit" });
      const timeoutMs = Math.min(Math.max(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : READ_WAIT_DEFAULT_MS, WAIT_POLL_MS), READ_WAIT_MAX_MS);
      const deadline = now() + timeoutMs;
      return (async () => {
        let snap = first;
        while (now() < deadline) {
          await sleep(WAIT_POLL_MS);
          snap = buildSnapshot();
          if (snap.screenText.includes(waitFor)) return { ...snap, waited: "hit" };
        }
        return { ...snap, waited: "timeout" };
      })();
    },
    paneLabels() {
      const labels = {};
      for (const session of sessions.values()) {
        if (!session.botPane || session.retired || session.exitCode !== null || active.get(session.key) !== session.id) continue;
        (labels[session.botId] ??= []).push(session.label ?? "");
      }
      return labels;
    },
    liveWorkerCount() {
      let count = 0;
      for (const session of sessions.values()) {
        if (session.botPane && !session.retired && session.exitCode === null && active.get(session.key) === session.id) count++;
      }
      return count;
    },
    sendBot(botId, input) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Confirmed send payloads cross the local IPC boundary.
      if (!input || typeof input !== "object") throw new Error("Invalid terminal send");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate every field before using the untyped IPC payload.
      if (typeof input.sessionId !== "string" || typeof input.generation !== "number" || !Number.isInteger(input.generation) || typeof input.text !== "string" || input.text.length > 64 * 1024) {
        throw new Error("Invalid terminal send");
      }
      const live = botSessions(botId);
      if (!live.length) throw new Error("No active terminal for this bot");
      // A restarted pane's old id is expected to stop resolving here (its
      // replacement took over the slot), so an unmatched or ambiguous id
      // keeps the existing "stale" wording rather than "Unknown terminal".
      const match = resolveBotSession(live, input.sessionId);
      const session = match.session;
      if (!session || session.generation !== input.generation) throw new Error("Terminal session is stale; take a fresh snapshot");
      if (session.exitCode !== null) throw new Error("Terminal has exited");
      if (input.text.includes("\x03")) throw new Error("Ctrl+C is not allowed in a confirmed terminal send");
      const result = botWrite(session, input.text);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge writes synchronously or asynchronously.
      return result && typeof result.then === "function" ? result.then(() => snapshot(session)) : snapshot(session);
    },
    attendBot(botId, sessionId, kind, text) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      const session = botSessions(botId).find((candidate) => candidate.id === sessionId);
      if (session && kind === "report") {
        session.reportAt = now();
        if (session.runningCommand) session.runningCommand.reported = true;
        paneRuns?.reported(session.id);
        session.finished = [];
        session.autoNote = null;
        session.autoReported = true;
      } else if (session && kind === "stall") session.stallReceiptAt = now();
      else if (session) session.noteAt = now();
      if (session && session.exitCode === null && kind === "auto" && typeof text === "string") {
        if (!session.autoReported && !session.autoDelivered && !session.autoNote?.tries) session.autoNote = { at: now(), text, tries: 0, retryAt: 0 };
        watchNotes();
        return true;
      }
      if (!session || session.exitCode !== null || session.attentionReported) return false;
      clearActivityTimer(session);
      return reportAttention(session, "activity");
    },
    closeBotPanes(botId) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      deletedBots.add(botId);
      for (const session of botSessions(botId)) if (session.botPane) paneRuns?.closed(session.id);
      return Promise.all(botSessions(botId).filter((session) => session.botPane).map((session) => retire(session, true)));
    },
    closeForBot(botId, sessionId) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      const match = resolveBotSession(botSessions(botId), sessionId);
      if (match.session) {
        if (!match.session.botPane) throw new Error("Only bot terminals can be closed");
        rememberClosedPane(botId, match.session.id);
        paneRuns?.closed(match.session.id);
        return retire(match.session, true).then(() => ({ alreadyClosed: false }));
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Session ids cross the local proxy boundary.
      if (!match.ambiguous && typeof sessionId === "string" && wasClosedPane(botId, sessionId)) return Promise.resolve({ alreadyClosed: true });
      throw new Error("Unknown terminal");
    },
    async openForBot(botId, input = {}) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      if (deletedBots.has(botId)) throw new Error("Terminal bot was deleted");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Spawn requests cross the local proxy boundary.
      if (!input || typeof input !== "object") throw new Error("Invalid terminal open");
      const label = paneLabel(input.label);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the optional first command before spawning.
      if (input.command !== undefined && (typeof input.command !== "string" || input.command.length > 64 * 1024 || input.command.includes("\x03"))) throw new Error("Invalid terminal command");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the optional folder before resolving it.
      if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("Invalid terminal folder");
      if (disposed) throw new Error("Terminal host is shutting down");
      const sender = paneOwner();
      if (!sender || sender.isDestroyed?.()) throw new Error("Wink window is not available");
      // Reserved before the first await so concurrent opens cannot overshoot the caps.
      const botReserved = paneReservations.get(botId) ?? 0;
      if (botSessions(botId).filter((session) => session.botPane && session.exitCode === null).length + botReserved >= BOT_PANE_LIMIT) throw new Error(`Too many bot terminals (limit ${BOT_PANE_LIMIT})`);
      if (active.size + reservedPanes >= SESSION_LIMIT) reclaimExited();
      const floor = paneMemoryFloor(input.command);
      const free = freeMemory();
      if (free < floor) {
        const names = await Promise.resolve().then(botNames).catch(() => ({}));
        throw new Error(`Not enough free memory for another terminal (${(free / 1024 ** 3).toFixed(1)} GB free, ${(floor / 1024 ** 3).toFixed(1)} GB needed).${openTerminals(names)} Close a finished pane with terminal_close.`);
      }
      paneReservations.set(botId, botReserved + 1);
      reservedPanes += 1;
      let session;
      try {
        const folder = await resolveFolder({ botId, cwd: input.cwd });
        if (folder.needsFolder) throw new Error("Terminal folder is unavailable");
        const cwd = folder.cwd;
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the API or requested folder before spawning.
        if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await fs.promises.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
          throw new Error("Terminal folder is unavailable");
        }
        if (disposed) throw new Error("Terminal host is shutting down");
        if (deletedBots.has(botId)) throw new Error("Terminal bot was deleted");
        const key = `${sender.id}:${botId}:pane:${randomUUID()}`;
        session = await start({ key, event: { sender }, input: { botId, cols: 120, rows: 30 }, folder, cwd, cancelPromise: new Promise(() => {}), botPane: true });
        if (disposed) {
          await retire(session, true);
          throw new Error("Terminal host is shutting down");
        }
        if (deletedBots.has(botId)) {
          await retire(session, true);
          throw new Error("Terminal bot was deleted");
        }
        session.botPane = true;
        session.label = label;
        session.spawnedAt = now();
        active.set(key, session.id);
      } finally {
        reservedPanes -= 1;
        const left = paneReservations.get(botId) - 1;
        if (left) paneReservations.set(botId, left);
        else paneReservations.delete(botId);
      }
      emit(session, "terminal:opened", { id: session.id, botId, label: label ?? null, generation: session.generation });
      if (input.command) {
        const command = normalizeTerminalText(input.command);
        session.command = command.endsWith("\r") ? command : `${command}\r`;
        await botWrite(session, session.command);
      }
      return { sessionId: session.id, generation: session.generation };
    },
    /** Starts the bot's main shell for a remote viewer: the same session the host's panel attaches to. */
    async openMainForBot(botId) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bot ids cross the local proxy boundary.
      if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) throw new Error("Invalid bot");
      if (deletedBots.has(botId)) throw new Error("Terminal bot was deleted");
      const sender = paneOwner();
      if (!sender || sender.isDestroyed?.()) throw new Error("Wink window is not available");
      const result = await openMain({ sender }, { botId, cols: 120, rows: 30 }, { trusted: true });
      if (!result || result.needsFolder) throw new Error("Terminal folder is unavailable");
      return { sessionId: result.id, generation: result.generation };
    },
    close(event, id) {
      const session = owned(event, id);
      if (!session.botPane) throw new Error("Only bot terminals can be closed");
      paneRuns?.closed(session.id);
      return retire(session, true);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      if (stallTimer) clearInterval(stallTimer);
      active.clear();
      const stopping = [...sessions.values()];
      const stops = stopping.map((session) => {
        session.retired = true;
        return retire(session);
      });
      sessions.clear();
      exitNotes.clear();
      disposal = Promise.all(stops)
        .then(() => timeout(Promise.all(exiting), QUIT_PANE_MS, "Terminal worker did not exit"))
        .catch(() => {});
      return disposal;
    },
  };
}
