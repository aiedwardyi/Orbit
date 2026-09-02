export function shouldMountLocalComputer({
  requested,
  hostPlatform = process.platform,
  providerSupportsLocal,
}: {
  requested: "cloud" | "local" | "off" | undefined;
  hostPlatform?: NodeJS.Platform;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (requested === "local") return hostPlatform === "darwin" || hostPlatform === "linux";
  // Preserve the established macOS Auto behavior. Linux local control is a
  // beta and can only be selected explicitly per bot.
  return requested === undefined && hostPlatform === "darwin";
}

/** Packaged Electron sets `OMB_PACKAGED=1` on the forked harness. */
export function packagedOrbitServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_PACKAGED === "1";
}

/** First-run packaged Windows has no host CUA Auto path. Chat must work
 * without Docker; Local VM stays an explicit later opt-in. */
export function defaultComputerForNewBot(host: {
  platform?: string;
  packaged?: boolean;
} = {}): "off" | undefined {
  const platform = host.platform ?? process.platform;
  const packaged = host.packaged ?? packagedOrbitServer();
  if (platform === "win32" && packaged) return "off";
  return undefined;
}

/** Explicit Local VM is opt-in. A missing container runtime must not
 * hard-fail ordinary chat; a runtime that is present still has to be ready. */
export function localVmTurnPlan(status: {
  runtime: string | null;
  ready: boolean;
}): "mount" | "skip-uninstalled" | "fail" {
  if (!status.runtime) return "skip-uninstalled";
  if (!status.ready) return "fail";
  return "mount";
}
