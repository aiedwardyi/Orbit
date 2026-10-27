import { openBlankTerminal, openInstallTerminal } from "./terminal-launch.mjs";

export function registerEngineInstall(ipcMain, { trusted, server, copy, fetch = globalThis.fetch, open = openInstallTerminal, blank = openBlankTerminal }) {
  ipcMain.handle("engine:install", async (event, instanceId) => {
    if (!trusted(event)) throw new Error("Untrusted install caller");
    if (typeof instanceId !== "string" || !/^[\w.-]+$/.test(instanceId)) throw new Error("Invalid engine id");
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
      if (await open(install)) return "running";
    } catch (error) {
      console.error("[engine-install] terminal launch failed:", error);
    }
    copy(install.command);
    return await blank() ? "opened" : "copied";
  });
}
