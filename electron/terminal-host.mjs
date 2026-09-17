import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnTerminalPty } from "./terminal-pty.mjs";

const require = createRequire(import.meta.url);
const OUTPUT_LIMIT = 256 * 1024;

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
  const pending = new Map();
  let disposed = false;
  const dimensions = (cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) {
      throw new Error("Invalid terminal dimensions");
    }
  };
  const snapshot = ({ id, cwd, shell, output, exitCode, seq }) => ({ id, cwd, shell, output, exitCode, seq });
  const owned = (event, id) => {
    authorize(event);
    const session = sessions.get(id);
    if (!session || session.owner !== event.sender) throw new Error("Unknown terminal");
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
    if (typeof input.cwd === "string" && input.cwd.trim()) {
      return { cwd: input.cwd.trim() };
    }
    const resolved = await resolveCwd(input.botId, event);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminated folder resolution may ask the UI to choose.
    if (resolved && typeof resolved === "object" && resolved.needsFolder === true) {
      return { needsFolder: true, reason: typeof resolved.reason === "string" ? resolved.reason : "choose-folder" };
    }
    // Server returns { cwd, source }; older stubs may still return a path string.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Normalize server and test stub shapes.
    const cwd = typeof resolved === "string" ? resolved : resolved?.cwd;
    return { cwd };
  };
  return {
    async open(event, input) {
      authorize(event);
      if (disposed) throw new Error("Terminal host is shutting down");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IPC input must be validated before resolving a shell folder.
      if (!input || typeof input.botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.botId)) throw new Error("Invalid bot");
      dimensions(input.cols, input.rows);
      const key = `${event.sender.id}:${input.botId}`;
      if (pending.has(key)) return pending.get(key);
      let existing = [...sessions.values()].find((s) => s.key === key);
      // Resume an existing session unless the caller explicitly confirmed restart.
      if (existing && input.restart !== true) {
        return snapshot(existing);
      }
      if (!existing && sessions.size >= 16) {
        for (const [id, session] of sessions) {
          if (session.exitCode !== null || session.owner.isDestroyed?.()) {
            try { session.pty.kill(); } catch {}
            sessions.delete(id);
          }
        }
      }
      if (sessions.size >= 16 && !existing) throw new Error("Too many terminal sessions");
      const task = (async () => {
        const folder = await resolveFolder(input, event);
        if (folder.needsFolder) return { needsFolder: true, reason: folder.reason };
        authorize(event);
        if (disposed) throw new Error("Terminal host is shutting down");
        const cwd = folder.cwd;
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the API or picked folder before spawning.
        if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await fs.promises.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
          throw new Error("Terminal folder is unavailable");
        }
        // Only after the new target validates may we replace a live session.
        if (existing) {
          if (existing.exitCode === null) {
            try { existing.pty.kill(); } catch {}
          }
          sessions.delete(existing.id);
          existing = null;
        }
        const shell = platform === "win32"
          ? [path.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((file) => fs.existsSync(file))
          : (env.SHELL || "/bin/sh");
        if (!shell) throw new Error("No terminal shell is available");
        const pty = loadPty().spawn(shell, platform === "win32" ? ["-NoLogo"] : [], {
          name: "xterm-256color", cols: input.cols, rows: input.rows, cwd, env: terminalEnvironment(env), useConptyDll: platform === "win32",
        });
        const session = { id: randomUUID(), key, owner: event.sender, cwd, shell, pty, output: "", exitCode: null, seq: 0 };
        sessions.set(session.id, session);
        if (typeof event.sender.once === "function") {
          event.sender.once("destroyed", () => {
            try { session.pty.kill(); } catch {}
            sessions.delete(session.id);
          });
        }
        pty.onData((data) => {
          session.output = (session.output + data).slice(-OUTPUT_LIMIT);
          emit(session, "terminal:data", { id: session.id, data, seq: ++session.seq });
        });
        pty.onExit(({ exitCode }) => {
          session.exitCode = exitCode;
          emit(session, "terminal:exit", { id: session.id, exitCode });
        });
        return snapshot(session);
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    },
    write(event, id, data) {
      const session = owned(event, id);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-text IPC payloads before passing them to the PTY.
      if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid terminal input");
      if (session.exitCode !== null) throw new Error("Terminal has exited");
      session.pty.write(data);
    },
    resize(event, id, cols, rows) {
      const session = owned(event, id);
      dimensions(cols, rows);
      if (session.exitCode === null) session.pty.resize(cols, rows);
    },
    dispose() {
      disposed = true;
      for (const session of sessions.values()) {
        if (session.exitCode === null) {
          try { session.pty.kill(); } catch {}
        }
      }
      sessions.clear();
    },
  };
}
