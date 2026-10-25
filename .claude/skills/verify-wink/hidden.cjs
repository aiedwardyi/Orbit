// Preloaded (--require) into every process the kit starts. Those run detached with no console,
// so any console child spawned without windowsHide would open a window on the user's screen.
const cp = require("node:child_process");
const { appendFileSync, existsSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

// WSL and containers boot VMs with windows of their own; cmdkey lists the user's real credentials.
const DENY = /(^|[\s"'\\/])(wsl|bash|tailscale|cmdkey|docker|podman)(\.exe)?(?=$|[\s"'])/i;
const SHELL = /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i;
// Arguments count only under a shell: an engine's prompt or settings JSON can say "Bash".
const denies = (file, line, shell) => DENY.test(file) || ((shell || SHELL.test(file)) && DENY.test(line));
const BLOCKED = "wink-verify-blocked.exe";
const log = process.env.WINK_SPAWN_LOG;
const note = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), from: process.pid, ...entry })}\n`);
};
const owned = new Set();

const spawnChild = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const { file } = options;
  const line = (options.args ?? [file]).join(" ");
  const denied = denies(String(file), line, false);
  if (denied) options.file = BLOCKED;
  options.windowsHide = true;
  try {
    return spawnChild.call(this, options);
  } finally {
    note({ pid: this.pid ?? null, file, cmd: line.slice(0, 300), denied });
    if (this.pid) {
      owned.add(this);
      this.once("exit", () => owned.delete(this));
    }
  }
};

for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const run = cp[name];
  cp[name] = function (file, ...rest) {
    const at = rest.findIndex((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
    if (at >= 0) rest[at] = { ...rest[at], windowsHide: true };
    else rest[name !== "execSync" && (Array.isArray(rest[0]) || rest[0] === undefined) ? 1 : 0] = { windowsHide: true };
    const line = [file, ...(Array.isArray(rest[0]) ? rest[0] : [])].join(" ");
    const denied = denies(String(file), line, name === "execSync" || rest.some((arg) => arg?.shell));
    note({ sync: true, file, cmd: line.slice(0, 300), denied });
    return run.call(this, denied ? BLOCKED : file, ...rest);
  };
}
syncBuiltinESMExports();

const stop = process.env.WINK_STOP_FILE;
if (stop) {
  const timer = setInterval(() => {
    if (!existsSync(stop)) return;
    clearInterval(timer);
    note({ stop: [...owned].map((child) => child.pid) });
    for (const child of owned) child.kill();
    // TerminateProcess, not process.exit: exit can abort Node on Windows while an IPC child is closing.
    setTimeout(() => process.kill(process.pid), 500);
  }, 500);
  timer.unref();
}
