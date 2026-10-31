// Phone access from anywhere (docs/phone-relay-design.md). The feature does
// not exist at runtime unless `phoneRelay.base` is set, `phoneRelay.enabled`
// is true and ORBIT_RELAY is not "0": until then nothing here opens a socket,
// starts a timer or creates a key.

import type { HarnessHandler } from "../early-listen.ts";
import type { PhoneRelayStatus, TeamSnag } from "../../shared/relay-protocol.ts";
import type { AcmeAccountConfig } from "./acme.ts";
import { enrollWith } from "./enroll.ts";
import { createPhoneRelay, defaultDeps } from "./runtime.ts";

export type { AcmeAccountConfig, AcmeExternalAccount } from "./acme.ts";

/** The `phoneRelay` section of ~/.orbit/config.json (design section 12). */
export interface PhoneRelayConfig {
  /** Base domain; empty or missing means the feature does not exist. */
  base?: string;
  /** User toggle in Settings. */
  enabled?: boolean;
  /** ACME directory URLs, tried in order. Defaults to Let's Encrypt. */
  acmeDirectories?: string[];
  /** Private per-directory ACME settings, keyed by directory URL. Only for CAs that need EAB or a contact. */
  acmeAccounts?: Record<string, AcmeAccountConfig>;
}

/** This PC's Google sign-in, as the relay's account directory needs it. */
export interface RelayAccountSource {
  /** The signed-in Google sub, null when signed out, undefined until the desktop says which. */
  sub(): string | null | undefined;
  /** The newest Desktop ID token, or null. */
  idToken(): string | null;
  /** Refreshes for a new ID token: null when none is coming before a sign-in, rejects when one may come later. */
  freshIdToken(): Promise<string | null>;
  /** The PC name phones see in the directory. */
  name(): string;
  /** The teammate's Wink profile name. Empty falls back to the PC name. */
  person?(): string;
}

export interface PhoneRelayOptions {
  dataDir: string;
  config: PhoneRelayConfig;
  /** The harness request handler that relay traffic is dispatched to. */
  handler: HarnessHandler;
  onStatus: (status: PhoneRelayStatus) => void;
  /** Without it the relay never hears of a Google account. */
  account?: RelayAccountSource;
}

export interface PhoneRelay {
  status(): PhoneRelayStatus;
  stop(): Promise<void>;
  /** The Google sign-in changed or brought a new ID token. */
  syncAccount?(): void;
  /** The PC name changed: authenticate again. Spliced phones stay up. */
  reauth?(): void;
  /** Whether this PC holds a wka1 for the signed-in account, so phones can find it. */
  accountReady?(): boolean;
  /** True once the relay stored or dropped the snag for good. */
  sendSnag?(snag: TeamSnag): Promise<boolean>;
}

export interface PhoneRelayEnrollOptions {
  dataDir: string;
  config: PhoneRelayConfig;
  /** Operator-signed invite (wki1...). Used once and never stored. */
  invite: string;
}

/** Returns at once; progress arrives through onStatus. */
export function startPhoneRelay(options: PhoneRelayOptions): PhoneRelay {
  return createPhoneRelay(options, defaultDeps());
}

/**
 * Creates or loads this PC's identity, trades the invite for a ticket at
 * https://relay.<base>/v1/enroll and stores the ticket. Throws with a short
 * reason on failure. Restart startPhoneRelay afterwards to connect.
 */
export function enrollPhoneRelay(options: PhoneRelayEnrollOptions): Promise<void> {
  return enrollWith(options);
}
