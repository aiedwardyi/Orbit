// Whether the relay feature exists for this config and environment.

import { RELAY_BASE_RE } from "../../shared/relay-protocol.ts";
import type { PhoneRelayConfig } from "./index.ts";

export type RelayMode = { kind: "off" } | { kind: "invalid"; reason: string } | { kind: "on"; base: string };

export function relayMode(config: PhoneRelayConfig, env: NodeJS.ProcessEnv): RelayMode {
  const base = (config.base ?? "").trim().toLowerCase();
  if (!base || config.enabled !== true || env.ORBIT_RELAY === "0") return { kind: "off" };
  return RELAY_BASE_RE.test(base) ? { kind: "on", base } : { kind: "invalid", reason: "phoneRelay.base is not a domain name" };
}

export function relayHostFor(base: string): string {
  return `relay.${base}`;
}
