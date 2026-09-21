import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { terminalPaneEnv } from "./terminal-mailbox.mjs";
import { spawnTerminalPty } from "./terminal-pty.mjs";
import { createTerminalScreen } from "./terminal-screen.mjs";

const require = createRequire(import.meta.url);
const OUTPUT_LIMIT = 256 * 1024;
const READY_TIMEOUT_MS = 5_000;
const WINDOWS_READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 500;
export const TERMINAL_ACTIVITY_COALESCE_MS = 750;
export const TERMINAL_ACTIVITY_ACK_COOLDOWN_MS = 3_000;
const INPUT_ECHO_LIMIT = 4_096;
const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const stringControl = new Set(["P", "^", "_", "X"]);

function isPrintable(char) {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export function createTerminalOutputParser() {
  let state = "normal";
  return {
    consume(data) {
      let text = "";
      let bell = false;
      for (const char of data) {
        if (state === "normal") {
          if (char === "\x1b") state = "escape";
          else if (char === "\x9b") state = "csi";
          else if (char === "\x9d") state = "osc";
          else if (char === "\x07") bell = true;
          else if (isPrintable(char) || char === "\r" || char === "\n" || char === "\t") text += char;
          continue;
        }
        if (state === "escape") {
          if (char === "[") state = "csi";
          else if (char === "]") state = "osc";
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
          if (char === "\x07") state = "normal";
          else if (char === "\x1b") state = "osc-escape";
          continue;
        }
        if (state === "osc-escape") {
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

export function createTerminalHost({ authorize, resolveCwd, mailbox = async () => null, loadPty = () => ({ spawn: (shell, args, options) => spawnTerminalPty(require.resolve("node-pty"), shell, args, options) }), env = process.env, platform = process.platform, readyTimeoutMs = terminalReadyTimeoutMs(platform), activityCoalesceMs = TERMINAL_ACTIVITY_COALESCE_MS, attentionCooldownMs = TERMINAL_ACTIVITY_ACK_COOLDOWN_MS, now = () => Date.now() }) {
  const sessions = new Map();
  const active = new Map();
  const generations = new Map();
  const pending = new Map();
  let disposed = false;
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
    return result;
  };
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
    if (session.retired || session.attentionReported) return;
    session.attentionReported = true;
    session.activityArmed = false;
    emit(session, "terminal:attention", { id: session.id, botId: session.botId, reason });
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
  const retire = async (session, forceKill = false) => {
    if (session.retired && session.stopPromise) return session.stopPromise;
    session.retired = true;
    clearActivityTimer(session);
    if (active.get(session.key) === session.id) active.delete(session.key);
    session.stopPromise = (async () => {
      if (forceKill || session.exitCode === null) {
        try {
          if (!session.workerReady) {
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may expose readiness only when worker-backed.
            const ptyReady = session.pty.ready;
            if (ptyReady && typeof ptyReady.then === "function") {
              try { await timeout(ptyReady, readyTimeoutMs, "Terminal worker did not become ready"); } catch {}
            }
            session.workerReady = true;
          }
          const result = session.pty.kill();
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
          if (result && typeof result.then === "function") await timeout(result, SHUTDOWN_TIMEOUT_MS, "Terminal shutdown timed out");
        } catch {
          try { session.pty.terminate?.(); } catch {}
        }
      }
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    })();
    return session.stopPromise;
  };
  const retireQuietly = (session, forceKill = false) => {
    void retire(session, forceKill).catch(() => {});
  };
  const reportExit = (session, exitCode) => {
    if (session.retired) return;
    if (session.exitCode === null) session.exitCode = exitCode;
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
    retireQuietly(session, true);
  };
  const attach = (session) => {
    session.pty.onData((data) => {
      if (session.retired) return;
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
      const echo = consumeInputEcho(parsed.text, session.pendingInputEcho);
      session.pendingInputEcho = echo.pending;
      if (parsed.bell && session.activityArmed) reportAttention(session, "bell");
      if (!parsed.bell && echo.text.trim()) scheduleActivity(session);
      emit(session, "terminal:data", { id: session.id, data, seq: ++session.seq });
    });
    session.pty.onExit(({ exitCode }) => reportExit(session, exitCode));
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The test adapter predates worker error events.
    if (typeof session.pty.onError === "function") session.pty.onError((error) => fail(session, error));
  };
  const start = async ({ key, event, input, folder, cwd, cancelPromise }) => {
    const shell = platform === "win32"
      ? [path.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((file) => fs.existsSync(file))
      : (env.SHELL || "/bin/sh");
    if (!shell) throw new Error("No terminal shell is available");
    const id = randomUUID();
    // A pane without orbit-msg beats no pane at all.
    const mail = await Promise.resolve().then(mailbox).catch(() => null);
    let pty;
    try {
      pty = await loadPty().spawn(shell, platform === "win32" ? ["-NoLogo"] : [], {
        name: "xterm-256color", cols: input.cols, rows: input.rows, cwd, env: terminalPaneEnv(terminalEnvironment(env), { pane: id, bot: input.botId, teacher: folder.teacher, mailbox: mail }), useConptyDll: platform === "win32",
      });
    } catch (cause) {
      throw errorValue(cause);
    }
    const session = {
      id, key, botId: input.botId, owner: event.sender, cwd, shell, pty, output: "", exitCode: null, seq: 0,
      launchProject: launchProject(input, folder, cwd), retired: false, exitReported: false, errorReported: false,
      failure: null, attentionReported: false, activityArmed: false, activityCooldownUntil: 0, activityTimer: null,
      outputParser: createTerminalOutputParser(), screen: createTerminalScreen({ cols: input.cols, rows: input.rows }), pendingInputEcho: "", truncated: false,
      workerReady: false,
    };
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
    authorize(operation.event);
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
    return snapshot(replacement);
  };
  return {
    async open(event, input) {
      authorize(event);
      if (disposed) throw new Error("Terminal host is shutting down");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC input must be validated before resolving a shell folder.
      if (!input || typeof input.botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.botId)) throw new Error("Invalid bot");
      dimensions(input.cols, input.rows);
      const key = `${event.sender.id}:${input.botId}`;
      while (true) {
        const inFlight = pending.get(key);
        if (!inFlight) break;
        if (inFlight.cancelled) {
          try { await inFlight.promise; } catch {}
          continue;
        }
        if (input.restart === true) {
          inFlight.restartInput = input;
        }
        return inFlight.promise;
      }
      const existing = current(key);
      if (existing && input.restart !== true) {
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
      if (!existing && active.size >= 16) {
        for (const [id, session] of sessions) {
          if (session.exitCode !== null || session.owner.isDestroyed?.()) {
            active.delete(session.key);
            sessions.delete(id);
            retireQuietly(session, true);
          }
        }
      }
      if (!existing && active.size >= 16) throw new Error("Too many terminal sessions");
      let cancelResolve;
      const cancelPromise = new Promise((resolve) => { cancelResolve = resolve; });
      const operation = { key, event, input, existing, restartInput: input.restart === true ? input : null, cancelled: false, cancelPromise, cancelResolve, promise: null };
      operation.promise = runOpen(operation);
      pending.set(key, operation);
      try {
        return await operation.promise;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
    cancelOpen(event, botId) {
      authorize(event);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC bot ids cross the untyped preload boundary.
      if (typeof botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw new Error("Invalid bot");
      const key = `${event.sender.id}:${botId}`;
      const operation = pending.get(key);
      if (!operation) return false;
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
      if (echo || submit) clearActivityTimer(session);
      if (submit) session.activityArmed = true;
      if (echo) session.pendingInputEcho = `${session.pendingInputEcho}${echo}`.slice(-INPUT_ECHO_LIMIT);
      // A shell can emit a bell more than once; arm the next command after Enter.
      if (submit) {
        session.attentionReported = false;
        session.activityCooldownUntil = 0;
      }
      // X10 bytes past column/row 95 exceed 0x7F; a UTF-8 string write
      // would expand them to two bytes, so send the raw binary instead.
      const payload = mouse && data.includes("\x1b[M") ? Buffer.from(data, "binary") : data;
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
      try {
        const result = session.pty.resize(cols, rows);
        session.screen.resize(cols, rows);
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
      let session = null;
      for (const candidate of sessions.values()) {
        if (candidate.botId === botId && !candidate.retired && active.get(candidate.key) === candidate.id) {
          session = candidate;
          break;
        }
      }
      if (!session) return { botId, state: "no-terminal", screenText: "", recentText: "", seq: 0, capturedAt: now(), exitCode: null, exited: false, truncated: false };
      const maxScreenChars = Number.isInteger(options.maxScreenChars) ? Math.max(1, Math.min(options.maxScreenChars, 64 * 1024)) : 64 * 1024;
      const maxScrollbackChars = Number.isInteger(options.maxScrollbackChars) ? Math.max(0, Math.min(options.maxScrollbackChars, 16 * 1024)) : 16 * 1024;
      return {
        botId,
        sessionId: session.id,
        generation: session.generation,
        cwd: session.cwd,
        seq: session.seq,
        capturedAt: now(),
        exitCode: session.exitCode,
        exited: session.exitCode !== null,
        ...session.screen.snapshot({ maxScreenChars, maxScrollbackChars }),
      };
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
      let session = null;
      for (const candidate of sessions.values()) {
        if (candidate.botId === botId && !candidate.retired && active.get(candidate.key) === candidate.id) {
          session = candidate;
          break;
        }
      }
      if (!session) throw new Error("No active terminal for this bot");
      if (session.id !== input.sessionId || session.generation !== input.generation) throw new Error("Terminal session is stale; take a fresh snapshot");
      if (session.exitCode !== null) throw new Error("Terminal has exited");
      if (input.text.includes("\x03")) throw new Error("Ctrl+C is not allowed in a confirmed terminal send");
      clearActivityTimer(session);
      const echo = inputEchoText(input.text);
      const submit = isSubmitInput(input.text);
      if (submit) session.activityArmed = true;
      if (submit) {
        session.attentionReported = false;
        session.activityCooldownUntil = 0;
      }
      if (echo) session.pendingInputEcho = `${session.pendingInputEcho}${echo}`.slice(-INPUT_ECHO_LIMIT);
      try {
        const result = session.pty.write(input.text);
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge writes synchronously or asynchronously.
        return result && typeof result.then === "function" ? result.then(() => snapshot(session)) : snapshot(session);
      } catch (cause) {
        fail(session, cause);
        throw cause;
      }
    },
    dispose() {
      disposed = true;
      active.clear();
      for (const session of sessions.values()) {
        session.retired = true;
        if (session.exitCode === null) retireQuietly(session, true);
      }
      sessions.clear();
    },
  };
}
