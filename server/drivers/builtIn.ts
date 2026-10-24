// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { MspMuseAgentDriver as MuseAgentDriver } from "./msp/muse.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokAgentDriver,
  MuseAgentDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  BoxAgentDriver,
];
