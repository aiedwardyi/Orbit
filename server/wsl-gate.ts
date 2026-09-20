// win32 gate on wsl.exe spawns, so a passive probe never boots the WSL VM.
//
// Every boot and every GET /api/instances probed the WSL-backed engines up
// to three times (`wsl muse --version`, `wsl bash -lc command -v muse`,
// `wsl sh -c test -f ...`). Each one restarts vmmemWSL and steals keyboard
// focus. A probe is allowed when the user asked for it — a turn, or an
// explicit rescan — or when WSL is already up; otherwise it is refused and
// the engine reads as asleep until the user wakes it.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export type WslProbeReason = "turn" | "rescan" | "passive";

const reasons = new AsyncLocalStorage<WslProbeReason>();

/** Every wsl.exe spawn under `fn` — probe, resolve, auth, turn — reads this. */
export function withWslProbeReason<T>(reason: WslProbeReason, fn: () => T): T {
  return reasons.run(reason, fn);
}

export function isWslCommand(cli: string): boolean {
  return /^\s*wsl(\.exe)?(\s|$)/i.test(cli);
}

/** Verified on Windows 11 with WSL shut down: this starts wslservice.exe
 * only — no vmmem process appears. wsl.exe answers in UTF-16LE. */
function listRunningDistros(): string {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
  const out = execFileSync(exe, ["--list", "--running", "--quiet"], {
    timeout: 3_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return Buffer.from(out).toString("utf16le");
}

type Gate = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; listRunning: () => string };
const live: Gate = { platform: process.platform, env: process.env, listRunning: listRunningDistros };
let gate = live;
let runningAt = 0;
let running = false;

/** Test hook — the gate reads the real platform and the real wsl.exe otherwise. */
export function setWslGateForTests(overrides: Partial<Gate> | null): void {
  gate = overrides ? { ...live, ...overrides } : live;
  runningAt = 0;
  running = false;
}

/** One listing per burst: a describe() asks once per WSL-backed instance. */
function wslRunning(): boolean {
  const now = Date.now();
  if (runningAt && now - runningAt < 3_000) return running;
  try {
    running = gate.listRunning().trim().length > 0;
  } catch {
    running = false;
  }
  runningAt = now;
  return running;
}

export function wslProbeAllowed(reason: WslProbeReason = reasons.getStore() ?? "passive"): boolean {
  if (gate.env.ORBIT_NO_WSL === "1") return false;
  if (gate.platform !== "win32") return true;
  return reason !== "passive" || wslRunning();
}

/** Why a WSL-backed engine is not answering, for the snapshot and the turn. */
export function wslBlockedReason(displayName: string): string {
  return gate.env.ORBIT_NO_WSL === "1"
    ? `${displayName} runs in WSL, which is disabled by ORBIT_NO_WSL=1.`
    : `${displayName} runs in WSL. Send it a message or press Check again to start WSL.`;
}
