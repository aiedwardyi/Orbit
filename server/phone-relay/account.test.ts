import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicKeyFromRaw } from "../../shared/relay-protocol.ts";
import { accountPayload } from "./account.ts";
import type { PhoneRelay, RelayAccountSource } from "./index.ts";
import { ACCOUNT_RETRY_MS, createPhoneRelay } from "./runtime.ts";
import { readAccount, readTicket, writeAccount } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { loopbackLookup } from "./testing/fake-relay.ts";
import { StatusLog, rig, type Rig } from "./testing/harness.ts";

const SUB = "google-sub-1";

function idToken(sub: string, issuedAt: number): string {
  const part = (json: string) => Buffer.from(json).toString("base64url");
  return `${part(JSON.stringify({ alg: "RS256", kid: "k" }))}.${part(JSON.stringify({ sub, iat: Math.floor(issuedAt / 1000) }))}.sig`;
}

/** A Google sign-in the test can change, as GoogleAccount would. */
function google(
  sub: string | null | undefined,
  token: string | null = null,
  fresh: () => Promise<string | null> = async () => null,
): RelayAccountSource & { sub_: string | null | undefined; token: string | null; refreshes: number } {
  return {
    sub_: sub,
    token,
    refreshes: 0,
    sub() {
      return this.sub_;
    },
    idToken() {
      return this.token;
    },
    async freshIdToken() {
      this.refreshes++;
      const next = await fresh();
      if (next) this.token = next;
      return next;
    },
    name: () => "Desk PC",
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("relay account directory", () => {
  let r: Rig | null = null;
  let relay: PhoneRelay | null = null;
  let clock = new FakeClock();

  afterEach(async () => {
    vi.restoreAllMocks();
    await relay?.stop();
    relay = null;
    await r?.close();
    r = null;
  });

  function start(rr: Rig, account?: RelayAccountSource) {
    const statuses = new StatusLog();
    clock = new FakeClock();
    relay = createPhoneRelay(
      { dataDir: rr.dataDir, config: rr.config, handler: (_req, res) => res.end(), onStatus: statuses.push, account },
      {
        clock,
        env: {},
        random: () => 0,
        connector: rr.relay.connector(),
        ctSource: null,
        acmeInsecureDirectories: true,
        https: { ca: rr.ca.certPem, port: rr.relay.port, lookup: loopbackLookup },
      },
    );
    return relay;
  }

  it("registers after a Google sign-in and sends the wka1 with the PC name", async () => {
    r = await rig();
    const rr = r;
    const handle = start(rr, google(SUB, idToken(SUB, Date.now())));
    await rr.relay.until(() => rr.relay.auths.some((auth) => auth.account));
    expect(rr.relay.accountBodies).toHaveLength(1);
    const body = JSON.parse(rr.relay.accountBodies[0]!);
    const ticket = readTicket(rr.dataDir);
    expect(body).toMatchObject({ pk: rr.identity.pk, ticket: ticket.kind === "ok" ? ticket.value : "" });
    expect(verify(null, accountPayload(body.idToken, body.ticket, body.pk), publicKeyFromRaw(body.pk)!, Buffer.from(body.sig, "base64url"))).toBe(true);
    const stored = readAccount(rr.dataDir);
    expect(stored.kind).toBe("ok");
    expect(rr.relay.auths.at(-1)).toMatchObject({ account: stored.kind === "ok" ? stored.value : "", name: "Desk PC" });
    expect(handle.accountReady?.()).toBe(true);
    expect(readFileSync(join(rr.dataDir, "phone-relay", "account.json"), "utf8")).not.toContain(body.idToken);
  });

  it("sends the stored wka1 in the first auth after a restart, without a new ID token", async () => {
    r = await rig();
    const rr = r;
    const wka1 = rr.relay.accountFor(rr.identity.label, SUB);
    writeAccount(rr.dataDir, wka1);
    const handle = start(rr, google(SUB));
    await rr.relay.until(() => rr.relay.auths.length === 1);
    expect(rr.relay.auths[0]).toMatchObject({ account: wka1, name: "Desk PC" });
    expect(rr.relay.accountBodies).toHaveLength(0);
    expect(handle.accountReady?.()).toBe(true);
  });

  it("keeps a wka1 the relay refreshes past half life", async () => {
    r = await rig();
    const rr = r;
    writeAccount(rr.dataDir, rr.relay.accountFor(rr.identity.label, SUB, 3600));
    const refreshed = rr.relay.accountFor(rr.identity.label, SUB);
    rr.relay.refreshAccount = refreshed;
    start(rr, google(SUB));
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    await vi.waitFor(() => expect(readAccount(rr.dataDir)).toEqual({ kind: "ok", value: refreshed }));
  });

  it("refuses a refreshed wka1 for another account", async () => {
    r = await rig();
    const rr = r;
    const wka1 = rr.relay.accountFor(rr.identity.label, SUB, 3600);
    writeAccount(rr.dataDir, wka1);
    rr.relay.refreshAccount = rr.relay.accountFor(rr.identity.label, "someone-else");
    start(rr, google(SUB));
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readAccount(rr.dataDir)).toEqual({ kind: "ok", value: wka1 });
  });

  it("sends account: null on sign-out, forgets the wka1, then authenticates as before", async () => {
    r = await rig();
    const rr = r;
    writeAccount(rr.dataDir, rr.relay.accountFor(rr.identity.label, SUB));
    const source = google(SUB);
    const handle = start(rr, source);
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    source.sub_ = null;
    handle.syncAccount?.();
    await rr.relay.until(() => rr.relay.count("control:ready") === 2);
    expect(rr.relay.auths[1]).toMatchObject({ account: null });
    expect(rr.relay.auths[1]).not.toHaveProperty("name");
    expect(readAccount(rr.dataDir).kind).toBe("missing");
    expect(handle.accountReady?.()).toBe(false);
    // The superseded session never reports the PC as rejected.
    expect(handle.status().state).not.toBe("rejected");
    rr.relay.dropControl(rr.identity.label);
    await vi.waitFor(() => {
      clock.advance(1);
      expect(rr.relay.auths).toHaveLength(3);
    });
    expect(rr.relay.auths[2]).not.toHaveProperty("account");
  });

  it("authenticates exactly as before without a Google sign-in", async () => {
    r = await rig();
    const rr = r;
    start(rr, google(null));
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    start(rr);
    await rr.relay.until(() => rr.relay.count("control:ready") === 2);
    for (const auth of rr.relay.auths) expect(Object.keys(auth).sort()).toEqual(["label", "pk", "sig", "ticket", "type"]);
    expect(rr.relay.accountBodies).toHaveLength(0);
  });

  it("refreshes the ID token when the wka1 is gone and the held one is too old, then registers", async () => {
    r = await rig();
    const rr = r;
    const fresh = idToken(SUB, Date.now());
    const source = google(SUB, idToken(SUB, Date.now() - 11 * 60_000), async () => fresh);
    const handle = start(rr, source);
    await rr.relay.until(() => rr.relay.auths.some((auth) => auth.account));
    expect(source.refreshes).toBe(1);
    expect(rr.relay.accountBodies).toHaveLength(1);
    expect(JSON.parse(rr.relay.accountBodies[0]!).idToken).toBe(fresh);
    expect(readAccount(rr.dataDir).kind).toBe("ok");
    expect(handle.accountReady?.()).toBe(true);
  });

  it("retries a refused registration with a fresh ID token at most once a minute", async () => {
    r = await rig();
    const rr = r;
    rr.relay.accountAnswer = () => ({ status: 403, body: JSON.stringify({ error: "token-stale" }) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const source = google(SUB, idToken(SUB, Date.now()), async () => idToken(SUB, Date.now() + ++n * 1000));
    start(rr, source);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(attempt));
      await settle();
      expect(rr.relay.accountBodies).toHaveLength(attempt);
      expect(source.refreshes).toBe(attempt - 1);
      clock.advance(ACCOUNT_RETRY_MS - 1);
      await settle();
      expect(rr.relay.accountBodies).toHaveLength(attempt);
      clock.advance(1);
    }
    expect(new Set(rr.relay.accountBodies.map((body) => JSON.parse(body).idToken)).size).toBe(3);
  });

  it("retries a failed ID token refresh at most once a minute", async () => {
    r = await rig();
    const rr = r;
    const source = google(SUB, null, async () => {
      throw new Error("Google account is offline");
    });
    start(rr, source);
    await vi.waitFor(() => expect(source.refreshes).toBe(1));
    await settle();
    clock.advance(ACCOUNT_RETRY_MS - 1);
    await settle();
    expect(source.refreshes).toBe(1);
    clock.advance(1);
    await vi.waitFor(() => expect(source.refreshes).toBe(2));
    expect(rr.relay.accountBodies).toHaveLength(0);
  });

  it("stops retrying after a sign-out", async () => {
    r = await rig();
    const rr = r;
    rr.relay.accountAnswer = () => ({ status: 403, body: JSON.stringify({ error: "token-stale" }) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = google(SUB, idToken(SUB, Date.now()), async () => idToken(SUB, Date.now() + 1000));
    const handle = start(rr, source);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    await settle();
    clock.advance(ACCOUNT_RETRY_MS);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    await settle();
    source.sub_ = null;
    source.token = null;
    handle.syncAccount?.();
    clock.advance(3 * ACCOUNT_RETRY_MS);
    await settle();
    expect(source.refreshes).toBe(1);
    expect(rr.relay.accountBodies).toHaveLength(2);
  });

  it("waits for a new sign-in when Google refuses the refresh (invalid_grant)", async () => {
    r = await rig();
    const rr = r;
    const source = google(SUB, idToken(SUB, Date.now() - 11 * 60_000));
    const handle = start(rr, source);
    await vi.waitFor(() => expect(source.refreshes).toBe(1));
    await settle();
    clock.advance(3 * ACCOUNT_RETRY_MS);
    await settle();
    expect(source.refreshes).toBe(1);
    expect(rr.relay.accountBodies).toHaveLength(0);
    expect(handle.accountReady?.()).toBe(false);
    source.token = idToken(SUB, clock.now());
    handle.syncAccount?.();
    await vi.waitFor(() => expect(handle.accountReady?.()).toBe(true));
    expect(rr.relay.accountBodies).toHaveLength(1);
  });

  it("registers nothing for an ID token from another account", async () => {
    r = await rig();
    const rr = r;
    start(rr, google(SUB, idToken("someone-else", Date.now())));
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    expect(rr.relay.accountBodies).toHaveLength(0);
  });

  it("keeps the stored wka1 until the desktop names the account", async () => {
    r = await rig();
    const rr = r;
    const wka1 = rr.relay.accountFor(rr.identity.label, SUB);
    writeAccount(rr.dataDir, wka1);
    const source = google(undefined);
    const handle = start(rr, source);
    await rr.relay.until(() => rr.relay.count("control:ready") === 1);
    expect(rr.relay.auths[0]).not.toHaveProperty("account");
    expect(readAccount(rr.dataDir)).toEqual({ kind: "ok", value: wka1 });
    source.sub_ = SUB;
    handle.syncAccount?.();
    await rr.relay.until(() => rr.relay.count("control:ready") === 2);
    expect(rr.relay.auths[1]).toMatchObject({ account: wka1 });
  });

  it("drops a wka1 for another Google account and registers the new one", async () => {
    r = await rig();
    const rr = r;
    writeAccount(rr.dataDir, rr.relay.accountFor(rr.identity.label, "someone-else"));
    const handle = start(rr, google(SUB, idToken(SUB, Date.now())));
    await rr.relay.until(() => rr.relay.auths.some((auth) => auth.account));
    const stored = readAccount(rr.dataDir);
    expect(rr.relay.auths.at(-1)).toMatchObject({ account: stored.kind === "ok" ? stored.value : "" });
    expect(handle.accountReady?.()).toBe(true);
    expect(existsSync(join(rr.dataDir, "phone-relay", "account.json"))).toBe(true);
  });

  it("logs a refused registration without the token and stays off", async () => {
    r = await rig();
    const rr = r;
    rr.relay.accountAnswer = () => ({ status: 403, body: JSON.stringify({ error: "token-stale" }) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = idToken(SUB, Date.now());
    const handle = start(rr, google(SUB, token));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("[phone-relay] account registration failed: relay refused the account (403 token-stale)"));
    expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
    expect(rr.relay.accountBodies).toHaveLength(1);
    expect(handle.accountReady?.()).toBe(false);
  });
});
