import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateKeyPairSync } from "node:crypto";
import { signTicket, type PhoneRelayStatus } from "../../shared/relay-protocol.ts";
import type { RelayConnector } from "./client.ts";
import type { Clock } from "./clock.ts";
import { startPhoneRelay, type PhoneRelayConfig } from "./index.ts";
import { createPhoneRelay, type PhoneRelayDeps } from "./runtime.ts";
import { loadOrCreateIdentity, relayDir, writeTicket } from "./store.ts";
import { tempDataDir } from "./testing/harness.ts";

/** Dependencies that fail the test if anything tries to use them. */
function forbiddenDeps(env: NodeJS.ProcessEnv = {}): PhoneRelayDeps {
  const clock: Clock = {
    now: () => Date.now(),
    schedule: () => {
      throw new Error("timer started");
    },
  };
  const connector: RelayConnector = {
    lookup: () => {
      throw new Error("DNS used");
    },
    connect: () => {
      throw new Error("socket opened");
    },
  };
  return { clock, env, connector, ctSource: { list: () => Promise.reject(new Error("CT used")), fetch: () => Promise.reject(new Error("CT used")) } };
}

const cases: Array<[string, PhoneRelayConfig, NodeJS.ProcessEnv]> = [
  ["missing base", { enabled: true }, {}],
  ["empty base", { base: " ", enabled: true }, {}],
  ["disabled", { base: "wink.example", enabled: false }, {}],
  ["toggle never set", { base: "wink.example" }, {}],
  ["ORBIT_RELAY=0", { base: "wink.example", enabled: true }, { ORBIT_RELAY: "0" }],
];

describe("startPhoneRelay off mode", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)("has no side effects with %s", async (_name, config, env) => {
    const { dir, cleanup } = tempDataDir();
    const dataDir = join(dir, "never");
    const listen = vi.spyOn(Server.prototype, "listen");
    try {
      const seen: PhoneRelayStatus[] = [];
      const relay = createPhoneRelay({ dataDir, config, handler: () => {}, onStatus: (s) => seen.push(s) }, forbiddenDeps(env));
      expect(relay.status()).toEqual({
        state: "off",
        host: null,
        relayRttMs: null,
        poolIdle: 0,
        certNotAfter: null,
        lastError: null,
        nextRetryAt: null,
      });
      await Promise.resolve();
      await relay.stop();
      expect(seen).toEqual([]);
      expect(existsSync(dataDir)).toBe(false);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("honours ORBIT_RELAY=0 through the public entry point", async () => {
    const { dir, cleanup } = tempDataDir();
    const previous = process.env.ORBIT_RELAY;
    process.env.ORBIT_RELAY = "0";
    try {
      const seen: PhoneRelayStatus[] = [];
      const relay = startPhoneRelay({ dataDir: join(dir, "never"), config: { base: "wink.example", enabled: true }, handler: () => {}, onStatus: (s) => seen.push(s) });
      expect(relay.status().state).toBe("off");
      await relay.stop();
      expect(seen).toEqual([]);
      expect(existsSync(join(dir, "never"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ORBIT_RELAY;
      else process.env.ORBIT_RELAY = previous;
      cleanup();
    }
  });
});

describe("startPhoneRelay before it can connect", () => {
  const config: PhoneRelayConfig = { base: "wink.example", enabled: true };

  async function quiet(dataDir: string, cfg = config) {
    const seen: PhoneRelayStatus[] = [];
    const relay = createPhoneRelay({ dataDir, config: cfg, handler: () => {}, onStatus: (s) => seen.push(s) }, forbiddenDeps());
    await Promise.resolve();
    const status = relay.status();
    await relay.stop();
    return { status, seen };
  }

  it("asks for enrollment without creating a key", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const { status, seen } = await quiet(dir);
      expect(status).toMatchObject({ state: "enrolling", host: null, lastError: null });
      expect(seen).toEqual([]);
      expect(existsSync(relayDir(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("shows the host but still waits for a ticket after an identity exists", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const identity = loadOrCreateIdentity(dir);
      const { status } = await quiet(dir);
      expect(status).toMatchObject({ state: "enrolling", host: `${identity.label}.wink.example` });
    } finally {
      cleanup();
    }
  });

  it("reports an expired ticket as rejected", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const identity = loadOrCreateIdentity(dir);
      const operator = generateKeyPairSync("ed25519").privateKey;
      const iat = Math.floor(Date.now() / 1000) - 7200;
      writeTicket(dir, signTicket({ label: identity.label, pk: identity.pk, iat, exp: iat + 3600 }, operator));
      const { status } = await quiet(dir);
      expect(status).toMatchObject({ state: "rejected", lastError: "ticket expired, enter an invite" });
    } finally {
      cleanup();
    }
  });

  it("refuses an unreadable identity and leaves it in place", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      mkdirSync(relayDir(dir), { recursive: true });
      const path = join(relayDir(dir), "identity.pem");
      writeFileSync(path, "junk");
      const { status } = await quiet(dir);
      expect(status.state).toBe("rejected");
      expect(readFileSync(path, "utf8")).toBe("junk");
    } finally {
      cleanup();
    }
  });

  it("rejects a base that is not a domain", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const { status } = await quiet(dir, { base: "not a domain", enabled: true });
      expect(status).toMatchObject({ state: "rejected", lastError: "phoneRelay.base is not a domain name" });
      expect(existsSync(relayDir(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
