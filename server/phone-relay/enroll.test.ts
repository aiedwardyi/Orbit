import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mintInvite } from "../../shared/relay-protocol.ts";
import { enrollWith } from "./enroll.ts";
import { enrollPhoneRelay } from "./index.ts";
import { readIdentity, readTicket, relayDir } from "./store.ts";
import { loopbackLookup } from "./testing/fake-relay.ts";
import { BASE, rig, tempDataDir, type Rig } from "./testing/harness.ts";

describe("enrollPhoneRelay", () => {
  let r: Rig | null = null;
  afterEach(async () => {
    await r?.close();
    r = null;
  });

  function deps(rr: Rig) {
    return { https: { ca: rr.ca.certPem, port: rr.relay.port, lookup: loopbackLookup }, env: {} };
  }

  it("signs the invite, stores a matching ticket and never stores the invite", async () => {
    r = await rig({ enroll: false });
    const invite = mintInvite(r.relay.operatorKey);
    await enrollWith({ dataDir: r.dataDir, config: r.config, invite }, deps(r));
    const identity = readIdentity(r.dataDir);
    const ticket = readTicket(r.dataDir);
    expect(identity.kind).toBe("ok");
    expect(ticket.kind).toBe("ok");
    const body = JSON.parse(r.relay.enrollBodies[0]);
    expect(body.invite).toBe(invite);
    expect(identity.kind === "ok" && body.pk).toBe(identity.kind === "ok" ? identity.value.pk : "");
    for (const name of readdirSync(relayDir(r.dataDir))) {
      expect(readFileSync(join(relayDir(r.dataDir), name), "utf8")).not.toContain(invite);
    }
    // A second enroll reuses the same identity.
    await enrollWith({ dataDir: r.dataDir, config: r.config, invite: mintInvite(r.relay.operatorKey) }, deps(r));
    expect(JSON.parse(r.relay.enrollBodies[1]).pk).toBe(body.pk);
  });

  it("rejects a ticket for another key and keeps no ticket", async () => {
    r = await rig({ enroll: false });
    const rr = r;
    rr.relay.enrollAnswer = () => ({ status: 200, body: JSON.stringify({ ticket: rr.relay.ticketFor("A".repeat(43)) }) });
    await expect(enrollWith({ dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) }, deps(rr))).rejects.toThrow(
      /unusable ticket/,
    );
    expect(readTicket(rr.dataDir).kind).toBe("missing");
  });

  it("surfaces relay refusals with the relay's code only", async () => {
    r = await rig({ enroll: false });
    const rr = r;
    rr.relay.enrollAnswer = () => ({ status: 403, body: JSON.stringify({ error: "invite-used" }) });
    await expect(enrollWith({ dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) }, deps(rr))).rejects.toThrow(
      "relay refused enrollment (403 invite-used)",
    );
    rr.relay.enrollAnswer = () => ({ status: 500, body: JSON.stringify({ error: "<script>" }) });
    await expect(enrollWith({ dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) }, deps(rr))).rejects.toThrow(
      "relay refused enrollment (500)",
    );
  });

  it("refuses redirects and oversized answers", async () => {
    r = await rig({ enroll: false });
    const rr = r;
    rr.relay.enrollAnswer = () => ({ status: 302, body: "", headers: { location: "https://elsewhere.test/v1/enroll" } });
    await expect(enrollWith({ dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) }, deps(rr))).rejects.toThrow(
      /redirect/,
    );
    rr.relay.enrollAnswer = () => ({ status: 200, body: JSON.stringify({ ticket: "x".repeat(64 * 1024) }) });
    await expect(enrollWith({ dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) }, deps(rr))).rejects.toThrow(
      /too large/,
    );
    expect(readTicket(rr.dataDir).kind).toBe("missing");
  });

  it("verifies the relay certificate", async () => {
    r = await rig({ enroll: false });
    const rr = r;
    await expect(
      enrollWith(
        { dataDir: rr.dataDir, config: rr.config, invite: mintInvite(rr.relay.operatorKey) },
        { https: { port: rr.relay.port, lookup: loopbackLookup }, env: {} },
      ),
    ).rejects.toThrow();
    expect(rr.relay.count("enroll")).toBe(0);
  });

  it.each([
    ["no base", { base: "", enabled: true }, {}],
    ["disabled", { base: BASE, enabled: false }, {}],
    ["ORBIT_RELAY=0", { base: BASE, enabled: true }, { ORBIT_RELAY: "0" }],
  ])("does nothing when off (%s)", async (_name, config, env) => {
    const { dir, cleanup } = tempDataDir();
    try {
      await expect(enrollWith({ dataDir: dir, config, invite: "wki1.a.b" }, { env })).rejects.toThrow("phone relay is off");
      expect(existsSync(relayDir(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("is exported with the agreed signature", async () => {
    const { dir, cleanup } = tempDataDir();
    try {
      await expect(enrollPhoneRelay({ dataDir: dir, config: {}, invite: "wki1.a.b" })).rejects.toThrow("phone relay is off");
      expect(existsSync(relayDir(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
