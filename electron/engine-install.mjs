import { openBlankTerminal, openInstallTerminal } from "./terminal-launch.mjs";

export function registerEngineInstall(ipcMain, { trusted, server, copy, fetch = globalThis.fetch, open = openInstallTerminal, blank = openBlankTerminal }) {
  const inFlight = new Map();
  ipcMain.handle("engine:install", async (event, instanceId, installOnly) => {
    if (!trusted(event)) throw new Error("Untrusted install caller");
    if (typeof instanceId !== "string" || !/^[\w.-]+$/.test(instanceId)) throw new Error("Invalid engine id");
    if (inFlight.get(instanceId) > Date.now()) return "running";
    inFlight.set(instanceId, Infinity);
    let running = false;
    try {
      const { port, token } = server();
      const response = await fetch(`http://127.0.0.1:${port}/api/instances/${encodeURIComponent(instanceId)}/install`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Could not resolve engine install");
      const install = await response.json();
      if (!install?.command) throw new Error("Unknown engine install");
      try {
        running = await open(installOnly === true ? { ...install, signInCommand: undefined } : install);
        if (running) return "running";
      } catch (error) {
        console.error("[engine-install] terminal launch failed:", error);
      }
      copy(install.command);
      return await blank() ? "opened" : "copied";
    } finally {
      // Launchers report spawn, not completion; 10 seconds covers repeat taps without blocking later retries.
      if (running) inFlight.set(instanceId, Date.now() + 10000);
      else inFlight.delete(instanceId);
    }
  });
}
