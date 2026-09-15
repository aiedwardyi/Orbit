// Meta Muse over MSP (`muse serve` stdio). Same driverKind as the ACP
// muse driver it replaces — stored configs key on the kind, so the fleet
// swap is one import change in drivers/builtIn.ts. WSL plumbing is shared
// with the ACP driver by import, never duplicated.
import type { ModelCatalog } from "../../contracts.ts";
import {
  classifyMuseError,
  MuseAgentDriver,
  museDefaultCli,
  museIsAuthenticated,
  museSignInCommand,
  museWslFallbackCli,
  resolveWslMuseCli,
  withWslKeySharing,
} from "../acp/muse.ts";
import { createMspDriver } from "./runtime.ts";

/** Live `model/list` on 1.2.1 advertises these four; the server default is
 * the contributor build. Kept static so boot never spawns for the catalog. */
export const MSP_MUSE_MODELS: ModelCatalog = {
  default: "muse-spark-1.3",
  options: [
    { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
    { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
    { id: "muse-spark-1.2", label: "Meta Muse 1.2" },
    { id: "muse-spark-1.2-contributor", label: "Meta Muse 1.2 Contributor" },
  ],
};

/** Live-verified on 1.3.0: a bogus-value probe returned all eight, each
 * accepted on real sessions. Literal max is accepted; never map it to
 * ultra. none leaves effort unset so the CLI keeps its own default. */
export const MSP_MUSE_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const MspMuseAgentDriver = createMspDriver({
  driverKind: "museAgent",
  displayName: "Meta Muse",
  models: MSP_MUSE_MODELS,
  effortLevels: MSP_MUSE_EFFORT_LEVELS,
  defaultCli: museDefaultCli(),
  nativeSource: "muse.msp",
  loginNote: `Muse CLI is not signed in — run \`${museSignInCommand()}\` in a terminal and complete the browser sign-in`,
  install: MuseAgentDriver.install,
  credentialEnv: ["META_API_KEY"],
  transformEnv: (env) => {
    if (process.platform === "win32") withWslKeySharing(env);
  },
  isAuthenticated: (env, config) => museIsAuthenticated(env, config),
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyMuseError,
  wslProbeWrapper: museWslFallbackCli,
  wslResolveCli: resolveWslMuseCli,
});
