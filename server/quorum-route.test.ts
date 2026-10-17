import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQuorumRoute, readQuorumToken } from "./quorum-route.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "ab12".repeat(16);
const URL_7 = "https://heyquorum.com/api/admin/stats?days=7";

const upstream = {
  generatedAt: "2026-10-17T03:12:00.000Z",
  timezone: "UTC",
  budget: { dailyCapCents: 4000, todayCountedCents: 1230 },
  tracking: { costSince: "2026-10-16", visitorsSince: null },
  totals: { users: 4 },
  days: [
    { day: "2026-10-16", costCents: 10.5, costByProvider: { claude: 10.5, other: 9 }, calls: 5, visitors: 2, signups: 1 },
    { day: "2026-10-17", costCents: 52.31, costByProvider: { gpt: 52.31 }, calls: 41, visitors: 3, signups: 0, ip: "1.2.3.4" },
  ],
};
const UPSTREAM = JSON.stringify(upstream);
const used = {
  days: [
    { day: "2026-10-16", costCents: 10.5, costByProvider: { claude: 10.5 }, visitors: 2, signups: 1 },
    { day: "2026-10-17", costCents: 52.31, costByProvider: { gpt: 52.31 }, visitors: 3, signups: 0 },
  ],
  budget: { dailyCapCents: 4000, todayCountedCents: 1230 },
  tracking: { costSince: "2026-10-16", visitorsSince: null },
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function route(fetchImpl: typeof fetch, token: string | null = TOKEN, now: () => number = () => 1_000) {
  return createQuorumRoute(() => token, fetchImpl, now);
}

const reply = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

describe("quorum route", () => {
  it("reads and trims the token file under the given home, else null", () => {
    const home = mkdtempSync(join(tmpdir(), "quorum-token-"));
    folders.push(home);
    expect(readQuorumToken(home)).toBeNull();
    mkdirSync(join(home, ".quorum-stats"));
    writeFileSync(join(home, ".quorum-stats", "token.txt"), `${TOKEN}\r\n`);
    expect(readQuorumToken(home)).toBe(TOKEN);
  });

  it("is off with no token file and never calls out", async () => {
    const fetchImpl = reply(UPSTREAM);
    expect(await route(fetchImpl, null)()).toEqual({ state: "off" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies a malformed token without a network call", async () => {
    const fetchImpl = reply(UPSTREAM);
    for (const bad of ["", "short", "g".repeat(64), `${TOKEN}0`, `${TOKEN.slice(1)}`]) {
      const result = await route(fetchImpl, bad)();
      expect(result).toEqual({ state: "denied" });
      if (bad) expect(JSON.stringify(result)).not.toContain(bad);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("trims a 200 to the fields the UI uses", async () => {
    const fetchImpl = reply(UPSTREAM);
    expect(await route(fetchImpl, TOKEN, () => 5_000)()).toEqual({ state: "ok", stats: used, fetchedAt: 5_000, now: 5_000 });
  });

  it("asks for 7 days with the bearer header and a 10 s deadline", async () => {
    const fetchImpl = reply(UPSTREAM);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await route(fetchImpl)();
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(URL_7, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: expect.any(AbortSignal) });
  });

  it("maps 404 to notEnabled and 401 to denied", async () => {
    expect(await route(reply("{}", 404))()).toEqual({ state: "notEnabled" });
    expect(await route(reply("{}", 401))()).toEqual({ state: "denied" });
  });

  it("reports error for a timeout, a network failure, another status or bad JSON", async () => {
    const stalled = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, rejectFetch) => {
      init?.signal?.addEventListener("abort", () => rejectFetch(init.signal!.reason));
    }));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), 10);
      return controller.signal;
    });
    try {
      expect(await route(stalled)()).toEqual({ state: "error", now: 1_000 });
    } finally {
      timeout.mockRestore();
    }
    expect(await route(vi.fn(async () => Promise.reject(new Error(`connect ECONNREFUSED ${TOKEN}`))))()).toEqual({ state: "error", now: 1_000 });
    expect(await route(reply("{}", 500))()).toEqual({ state: "error", now: 1_000 });
    expect(await route(vi.fn(async () => new Response("not json", { status: 200 })))()).toEqual({ state: "error", now: 1_000 });
  });

  it("rejects stats that are not finite, are too long, or miss a day", async () => {
    const day = upstream.days[0]!;
    const long = Array.from({ length: 91 }, () => day);
    for (const body of [
      { ...upstream, days: [{ ...day, costCents: "5" }] },
      { ...upstream, days: [{ ...day, visitors: Number.POSITIVE_INFINITY }] },
      { ...upstream, days: [{ ...day, day: `x ${TOKEN}` }] },
      { ...upstream, days: [] },
      { ...upstream, days: long },
      { ...upstream, tracking: undefined },
    ]) {
      const result = await route(reply(JSON.stringify(body)))();
      expect(result).toEqual({ state: "error", now: 1_000 });
    }
    const max = Array.from({ length: 90 }, () => day);
    expect((await route(reply(JSON.stringify({ ...upstream, days: max })))()).state).toBe("ok");
  });

  it("hides the cap when the budget is missing", async () => {
    const result = await route(reply(JSON.stringify({ ...upstream, budget: undefined })))();
    expect(result).toMatchObject({ state: "ok", stats: { budget: null } });
  });

  it("returns the last good stats on error, and only on error", async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(upstream), { status: 200 }));
    const next = route(fetchImpl, TOKEN, () => clock);
    expect(await next()).toMatchObject({ state: "ok" });
    clock = 9_000;
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await next()).toEqual({ state: "error", now: 9_000, stats: used, fetchedAt: 1_000 });
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect(await next()).toEqual({ state: "notEnabled" });
    expect(await route(reply("{}", 503))()).toEqual({ state: "error", now: 1_000 });
  });

  it("never puts the token in a reply", async () => {
    const hostile = { ...upstream, note: TOKEN, days: [{ ...upstream.days[0], costByProvider: { claude: 1, [TOKEN]: 2 } }] };
    const kept = route(reply(JSON.stringify(hostile)));
    const results = [
      await route(reply(UPSTREAM), null)(),
      await route(reply(UPSTREAM), `${TOKEN}!`)(),
      await route(reply(UPSTREAM))(),
      await route(reply("{}", 404))(),
      await route(reply("{}", 401))(),
      await route(vi.fn(async () => Promise.reject(new Error(TOKEN))))(),
      await route(reply(`"${TOKEN} not an object"`))(),
      await kept(),
    ];
    for (const result of results) expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("is served from the server entry beside the team route", () => {
    const index = readFileSync(join(ROOT, "server/index.ts"), "utf8");
    expect(index).toContain('import { quorumRoute } from "./quorum-route.ts"');
    expect(index).toContain('method === "GET" && path === "/api/quorum"');
    expect(index).toContain("json(res, 200, await quorumRoute())");
    expect(index.indexOf('path === "/api/quorum"')).toBeGreaterThan(index.indexOf('path === "/api/team"'));
    expect(index.indexOf('path === "/api/quorum"')).toBeGreaterThan(index.indexOf('path.startsWith("/api/") && !(method === "GET" && path === "/api/health")'));
  });
});
