// Phone access from anywhere (docs/phone-relay-design.md). Stub: the relay
// client, ingress and certificates land in later changes. Until then the
// feature always reports "off" and opens nothing.

import type { HarnessHandler } from "../early-listen.ts";
import { PHONE_RELAY_OFF, type PhoneRelayStatus } from "../../shared/relay-protocol.ts";

/** The `phoneRelay` section of ~/.orbit/config.json (design section 12). */
export interface PhoneRelayConfig {
  /** Base domain; empty or missing means the feature does not exist. */
  base?: string;
  /** User toggle in Settings. */
  enabled?: boolean;
  /** ACME directory URLs, tried in order. */
  acmeDirectories?: string[];
}

export interface PhoneRelayOptions {
  dataDir: string;
  config: PhoneRelayConfig;
  /** The harness request handler that relay traffic is dispatched to. */
  handler: HarnessHandler;
  onStatus: (status: PhoneRelayStatus) => void;
}

export interface PhoneRelay {
  status(): PhoneRelayStatus;
  stop(): Promise<void>;
}

export function startPhoneRelay(_options: PhoneRelayOptions): PhoneRelay {
  return {
    status: () => ({ ...PHONE_RELAY_OFF }),
    stop: async () => {},
  };
}
