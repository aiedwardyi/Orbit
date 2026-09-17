import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnTerminalPty } from "./terminal-pty.mjs";

const require = createRequire(import.meta.url);
const OUTPUT_LIMIT = 256 * 1024;
const READY_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 500;

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

export function createTerminalHost({ authorize, resolveCwd, loadPty = () => ({ spawn: (shell, args, options) => spawnTerminalPty(require.resolve("node-pty"), shell, args, options) }), env = process.env, platform = process.platform }) {
  const sessions = new Map();
  const active = new Map();
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
    const result = { id: session.id, cwd: session.cwd, shell: session.shell, output: session.output, exitCode: session.exitCode, seq: session.seq };
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
    return { cwd, source };
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
    if (active.get(session.key) === session.id) active.delete(session.key);
    session.stopPromise = (async () => {
      if (forceKill || session.exitCode === null) {
        try {
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
  const reportExit = (session, exitCode) => {
    if (session.exitCode === null) session.exitCode = exitCode;
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
    if (!session.errorReported) {
      session.errorReported = true;
      emit(session, "terminal:error", { id: session.id, message: error.message });
    }
    reportExit(session, 1);
    void retire(session, true);
  };
  const attach = (session) => {
    session.pty.onData((data) => {
      session.output = (session.output + data).slice(-OUTPUT_LIMIT);
      emit(session, "terminal:data", { id: session.id, data, seq: ++session.seq });
    });
    session.pty.onExit(({ exitCode }) => reportExit(session, exitCode));
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The test adapter predates worker error events.
    if (typeof session.pty.onError === "function") session.pty.onError((error) => fail(session, error));
  };
  const start = async ({ key, event, input, folder, cwd }) => {
    const shell = platform === "win32"
      ? [path.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((file) => fs.existsSync(file))
      : (env.SHELL || "/bin/sh");
    if (!shell) throw new Error("No terminal shell is available");
    let pty;
    try {
      pty = await loadPty().spawn(shell, platform === "win32" ? ["-NoLogo"] : [], {
        name: "xterm-256color", cols: input.cols, rows: input.rows, cwd, env: terminalEnvironment(env), useConptyDll: platform === "win32",
      });
    } catch (cause) {
      throw errorValue(cause);
    }
    const session = {
      id: randomUUID(), key, owner: event.sender, cwd, shell, pty, output: "", exitCode: null, seq: 0,
      launchProject: launchProject(input, folder, cwd), retired: false, exitReported: false, errorReported: false,
      failure: null,
    };
    sessions.set(session.id, session);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Electron sender mocks may omit lifecycle events.
    if (typeof event.sender.once === "function") {
      event.sender.once("destroyed", () => { void retire(session, true); });
    }
    attach(session);
    try {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may expose readiness only when worker-backed.
      if (pty.ready && typeof pty.ready.then === "function") await timeout(pty.ready, READY_TIMEOUT_MS, "Terminal worker did not become ready");
      if (session.failure) throw session.failure;
      return session;
    } catch (cause) {
      await retire(session, true);
      throw errorValue(cause);
    }
  };
  const runOpen = async (operation) => {
    let input = operation.input;
    let folder = await resolveFolder(input, operation.event);
    if (operation.restartInput && operation.restartInput !== input) {
      input = operation.restartInput;
      folder = await resolveFolder(input, operation.event);
    }
    if (folder.needsFolder) return { needsFolder: true, reason: folder.reason };
    authorize(operation.event);
    if (disposed) throw new Error("Terminal host is shutting down");
    const cwd = folder.cwd;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the API or picked folder before spawning.
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await fs.promises.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
      throw new Error("Terminal folder is unavailable");
    }
    const replacement = await start({ key: operation.key, event: operation.event, input, folder, cwd });
    if (disposed) {
      await retire(replacement, true);
      throw new Error("Terminal host is shutting down");
    }
    active.set(operation.key, replacement.id);
    if (operation.existing && operation.existing !== replacement) await retire(operation.existing);
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
      const inFlight = pending.get(key);
      if (inFlight) {
        if (input.restart === true) {
          inFlight.restartInput = input;
        }
        return inFlight.promise;
      }
      const existing = current(key);
      if (existing && input.restart !== true) return snapshot(existing);
      if (!existing && active.size >= 16) {
        for (const [id, session] of sessions) {
          if (session.exitCode !== null || session.owner.isDestroyed?.()) {
            active.delete(session.key);
            sessions.delete(id);
            void retire(session, true);
          }
        }
      }
      if (!existing && active.size >= 16) throw new Error("Too many terminal sessions");
      const operation = { key, event, input, existing, restartInput: input.restart === true ? input : null, promise: null };
      operation.promise = runOpen(operation);
      pending.set(key, operation);
      try {
        return await operation.promise;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
    write(event, id, data) {
      const session = owned(event, id);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-text IPC payloads before passing them to the PTY.
      if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid terminal input");
      if (session.exitCode !== null) throw new Error("Terminal has exited");
      try {
        const result = session.pty.write(data);
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
        return result && typeof result.then === "function" ? result.catch((cause) => { fail(session, cause); throw cause; }) : result;
      } catch (cause) {
        fail(session, cause);
        throw cause;
      }
    },
    resize(event, id, cols, rows) {
      const session = owned(event, id);
      dimensions(cols, rows);
      if (session.exitCode !== null) return undefined;
      try {
        const result = session.pty.resize(cols, rows);
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PTY adapters may acknowledge operations synchronously or asynchronously.
        return result && typeof result.then === "function" ? result.catch((cause) => { fail(session, cause); throw cause; }) : result;
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
        if (session.exitCode === null) void retire(session, true);
      }
      sessions.clear();
    },
  };
}
