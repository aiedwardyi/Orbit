import { execFile } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { join as joinPath } from "node:path";

/** Resolve only after the launcher really spawns or reports an error. */
function launch(executable, args, options, run = execFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(executable, args, options);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) child.unref?.();
      resolve(ok);
    };
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
}

/** Whether `name` resolves on PATH (PATHEXT-aware on win32). Only presence
 * matters — `start` resolves the same PATH again, so the bare name is what
 * runs either way. Deps injectable so the pwsh preference is unit-testable
 * off Windows. */
function hasOnPath(name, { platform, pathEnv, pathExt, existsSync }) {
  const delimiter = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32"
      ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean)
      : [""];
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (existsSync(joinPath(dir, name + ext))) return true;
      } catch {
        /* unreadable dir — keep looking */
      }
    }
  }
  return false;
}

/** Open a blank terminal. Installer text is deliberately not accepted here,
 * so renderer-controlled input can never become a process argument. */
export async function openBlankTerminal(platform = process.platform, run = execFile, deps = {}) {
  if (platform === "darwin") {
    return launch(
      "osascript",
      ["-e", 'tell application "Terminal" to activate'],
      undefined,
      run,
    );
  }
  if (platform === "win32") {
    // A direct spawn opens no visible window from the packaged main (the
    // console never foregrounds), so the shell goes through `start`, which
    // opens a new window in the user's default terminal — verified against
    // the packaged build. -NoProfile: a broken user profile (seen live: a
    // PS5.1 profile importing a PS7-only Terminal-Icons) otherwise errors
    // the window out from under the paste. pwsh when present, else the
    // inbox powershell.exe. The title and every argument are fixed: no
    // renderer input reaches the command line.
    const shell = hasOnPath("pwsh", {
      platform,
      pathEnv: deps.pathEnv ?? process.env.PATH,
      pathExt: deps.pathExt ?? process.env.PATHEXT,
      existsSync: deps.existsSync ?? defaultExistsSync,
    })
      ? "pwsh"
      : "powershell.exe";
    return launch("cmd.exe", ["/c", "start", "", shell, "-NoProfile", "-NoExit"], { windowsHide: true }, run);
  }
  if (platform === "linux") {
    for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
      if (await launch(terminal, [], undefined, run)) return true;
    }
  }
  return false;
}
