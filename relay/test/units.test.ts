import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits.ts";
import { peerAddress, peerPrefix, rateKey } from "../src/net-util.ts";
import { RevocationList } from "../src/revocation.ts";
import { makePc } from "./fixtures.ts";

describe("rate limiter", () => {
  it("allows a burst then refills at the rate, per key", () => {
    let t = 0;
    const limiter = new RateLimiter(1, 3, () => t);
    expect([1, 2, 3, 4].map(() => limiter.take("a"))).toEqual([true, true, true, false]);
    expect(limiter.take("b")).toBe(true);
    t += 1000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("bounds the number of tracked keys", () => {
    const limiter = new RateLimiter(0, 1, () => 0, 2);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("c")).toBe(true);
    // "a" was evicted, so it starts with a fresh bucket.
    expect(limiter.take("a")).toBe(true);
  });
});

describe("peer helpers", () => {
  it("logs only /24 or /48 prefixes and keys IPv6 limits by /64", () => {
    expect(peerPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(peerPrefix("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(peerPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(peerPrefix("::1")).toBe("0:0:0::/48");
    expect(peerPrefix(undefined)).toBeNull();
    expect(rateKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2");
    expect(rateKey("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(peerAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("revocation list", () => {
  it("reads labels, ignores junk and reports newly revoked labels", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "wink-rev-")), "revoked");
    const a = makePc().label;
    const b = makePc().label;
    const list = new RevocationList(file);
    expect(await list.reload(true)).toEqual([]);
    await writeFile(file, `# comment\n${a}\nnot-a-label\n  ${b.toUpperCase()}  # trailing\n`);
    expect((await list.reload(true)).sort()).toEqual([a, b].sort());
    expect(list.has(a) && list.has(b)).toBe(true);
    await writeFile(file, `${b}\n`);
    expect(await list.reload(true)).toEqual([]);
    expect(list.has(a)).toBe(false);
  });
});
