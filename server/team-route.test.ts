import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { teamIdToken, teamRelayOrigin, teamRoute, type TeamTokenSource } from "./team-route.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const payload = { now: 1, days: ["2026-10-12"], pcs: [], people: [{ id: "p", name: "Ada" }] };

function jwt(iatMs: number): string {
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: Math.floor(iatMs / 1000) })).toString("base64url");
  return `e.${body}.s`;
}

function source(held: string | null, fresh: string | null = null): TeamTokenSource & { refreshes: number } {
  const state = {
    refreshes: 0,
    idToken: () => held,
    freshIdToken: async () => {
      state.refreshes += 1;
      return fresh;
    },
  };
  return state;
}

describe("team route", () => {
  it("uses the enrolled relay, else the baked origin, and never an odd host", () => {
    expect(teamRelayOrigin("wink.example", "other.example")).toBe("https://relay.wink.example");
    expect(teamRelayOrigin(null, "https://relay.wink.example")).toBe("https://relay.wink.example");
    expect(teamRelayOrigin(null, "relay.wink.example")).toBe("https://relay.wink.example");
    expect(teamRelayOrigin(null, null)).toBeNull();
    expect(teamRelayOrigin(null, "http://relay.wink.example")).toBeNull();
    expect(teamRelayOrigin(null, "not a host")).toBeNull();
  });

  it("keeps a held ID token and refreshes only when there is none", async () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const recent = jwt(now - 60_000);
    const held = source(recent, "fresh-token");
    expect(await teamIdToken(held, () => now)).toBe(recent);
    expect(held.refreshes).toBe(0);
    const empty = source(null, "fresh-token");
    expect(await teamIdToken(empty)).toBe("fresh-token");
    expect(empty.refreshes).toBe(1);
    const offline = source(null);
    offline.freshIdToken = async () => {
      throw new Error("offline");
    };
    expect(await teamIdToken(offline)).toBeNull();
  });

  it("refreshes a held ID token once it is past the relay's max age", async () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const staleHeld = jwt(now - 2 * 60 * 60 * 1000);
    const stale = source(staleHeld, "fresh-token");
    expect(await teamIdToken(stale, () => now)).toBe("fresh-token");
    expect(stale.refreshes).toBe(1);
    const recentHeld = jwt(now - 60_000);
    const recent = source(recentHeld, "fresh-token");
    expect(await teamIdToken(recent, () => now)).toBe(recentHeld);
    expect(recent.refreshes).toBe(0);
  });

  it("serves the relay payload for the owner", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload));
    const now = Date.parse("2026-10-12T00:00:00Z");
    const hash = createHash("sha256").update("owner@example.com").digest("hex");
    const reply = await teamRoute(null, "wink.example", hash, "owner@example.com", source("token"), fetchImpl, () => now);
    expect(reply).toEqual({ status: 200, body: payload });
    expect(fetchImpl).toHaveBeenCalledWith(`https://relay.wink.example/v1/team?tz=${-new Date(now).getTimezoneOffset()}`, {
      headers: { authorization: "Bearer token" },
    });
  });

  it("calls the relay only for the baked owner's email", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload));
    const now = Date.parse("2026-10-12T00:00:00Z");
    const hash = createHash("sha256").update("owner@example.com").digest("hex");
    const held = source(jwt(now - 60_000), "fresh-token");
    expect(await teamRoute(null, "wink.example", hash, "Other@Example.com", held, fetchImpl, () => now)).toEqual({ status: 403, body: { owner: false } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(held.refreshes).toBe(0);
    expect(await teamRoute(null, "wink.example", hash, " Owner@Example.com ", source(jwt(now - 60_000)), fetchImpl, () => now)).toEqual({ status: 200, body: payload });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await teamRoute(null, "wink.example", null, "owner@example.com", source(jwt(now - 60_000)), fetchImpl, () => now)).toEqual({ status: 403, body: { owner: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is not the owner without a relay, a session, or when the relay says no", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "not-owner" }, { status: 403 }));
    const hash = createHash("sha256").update("owner@example.com").digest("hex");
    expect(await teamRoute(null, null, hash, "owner@example.com", source("token"), fetchImpl)).toEqual({ status: 403, body: { owner: false } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await teamRoute(null, "wink.example", hash, "owner@example.com", source(null), fetchImpl)).toEqual({ status: 403, body: { owner: false } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await teamRoute(null, "wink.example", hash, "owner@example.com", source("token"), fetchImpl)).toEqual({ status: 403, body: { owner: false } });
    fetchImpl.mockResolvedValueOnce(Response.json({ error: "no" }, { status: 401 }));
    expect(await teamRoute(null, "wink.example", hash, "owner@example.com", source("token"), fetchImpl)).toEqual({ status: 403, body: { owner: false } });
  });

  it("is called from the server entry, not inlined there", () => {
    const index = readFileSync(join(ROOT, "server/index.ts"), "utf8");
    expect(index).toContain('path === "/api/team"');
    expect(index).toContain("teamRoute(phoneAccess.base(), googleEnv.teamRelay, googleEnv.teamOwner, googleAccount.owner()?.email ?? null, googleAccount)");
    expect(index).toContain('person: () => (cfg.profile?.name ?? "").trim()');
    expect(index).toContain("if ((cfg.profile?.name ?? \"\").trim() !== previousPerson) phoneAccess.nameChanged()");
  });
});
