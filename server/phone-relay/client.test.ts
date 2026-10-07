import type { TLSSocket } from "node:tls";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKOFF_CAP_MS,
  BACKOFF_LONG_CAP_MS,
  DRAIN_MAX_MS,
  DRAIN_MIN_MS,
  HEARTBEAT_MS,
  RelayClient,
  TICK_MS,
  type RelayConnector,
} from "./client.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { rig, type Rig } from "./testing/harness.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("relay client", () => {
  let r: Rig | null = null;
  let client: RelayClient | null = null;

  afterEach(async () => {
    client?.stop();
    client = null;
    await r?.close();
    r = null;
  });

  function start(options: { connector?: RelayConnector; clock?: FakeClock; random?: () => number; onGo?: (socket: TLSSocket, head: Buffer, peer: string) => void } = {}) {
    if (!r) throw new Error("rig first");
    const clock = options.clock ?? new FakeClock();
    let changes = 0;
    const tickets: string[] = [];
    const rr = r;
    const c = new RelayClient({
      relayHost: rr.relay.relayHost,
      identity: rr.identity,
      ticket: rr.relay.ticketFor(rr.identity.pk),
      connector: options.connector ?? rr.relay.connector(),
      clock,
      random: options.random ?? (() => 0.5),
      onGo: (socket, head, peer) => {
        (options.onGo ?? ((s: TLSSocket) => s.destroy()))(socket, head, peer);
        bus.emit("event");
      },
      onTicket: (ticket) => {
        tickets.push(ticket);
        return true;
      },
      onChange: () => {
        changes++;
        bus.emit("event");
      },
    });
    client = c;
    c.start();
    return { c, clock, tickets, changes: () => changes };
  }

  it("authenticates and keeps three idle data channels, refilling after go", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    const gone: string[] = [];
    const { c } = start({ onGo: (socket, _head, peer) => {
      gone.push(peer);
      socket.destroy();
    } });
    await waitFor(() => relay.idleCount(label) === 3);
    expect(c.snapshot()).toMatchObject({ state: "connected", poolIdle: 3, lastError: null });
    expect(r.relay.lookups).toBe(4);

    const phone = r.relay.phone(r.host);
    phone.on("error", () => {});
    await waitFor(() => gone.length === 1);
    expect(gone).toEqual(["203.0.113.7"]);
    await waitFor(() => relay.idleCount(label) === 3);
    expect(r.relay.lookups).toBe(5);
    phone.destroy();
  });

  it("bursts toward pool.max when a phone drains the pool, bounded by parallel opens", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    r.relay.pool = { min: 1, max: 5 };
    start();
    await waitFor(() => relay.idleCount(label) === 1);
    const phone = r.relay.phone(r.host);
    phone.on("error", () => {});
    await waitFor(() => relay.idleCount(label) === 5);
    expect(r.relay.count("data:join")).toBe(6);
    phone.destroy();
  });

  it("asks for more channels on want even with idle ones left", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    r.relay.pool = { min: 1, max: 3 };
    start();
    await waitFor(() => relay.idleCount(label) === 1);
    r.relay.send(label, { type: "want", n: 2 });
    await waitFor(() => relay.idleCount(label) === 3);
  });

  it("reconnects with jittered backoff after a disconnect and resolves DNS again", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    const addresses = ["10.0.0.1", "10.0.0.2"];
    const used: string[] = [];
    const connector = r.relay.connector(() => addresses[Math.min(relay.count("control:open"), 1)], (address, alpn) => {
      if (alpn === "wink-ctl/1") used.push(address);
    });
    const { c, clock } = start({ connector, random: () => 0.5 });
    await waitFor(() => relay.idleCount(label) === 3);
    const lookupsBefore = r.relay.lookups;

    r.relay.dropControl(label);
    await waitFor(() => c.snapshot().state === "backoff" || relay.count("control:close") > 0);
    await waitFor(() => c.snapshot().state === "backoff");
    const snap = c.snapshot();
    expect(snap.lastError).toBe("connection to relay closed");
    expect(snap.nextRetryAt).toBe(clock.now() + 500);
    expect(snap.poolIdle).toBe(0);

    clock.advance(500);
    await waitFor(() => relay.idleCount(label) === 3 && c.snapshot().state === "connected");
    expect(used).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(r.relay.lookups).toBe(lookupsBefore + 4);
  });

  it("grows the backoff cap, then raises it after an hour of failures", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    const failing: RelayConnector = {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
      connect: () => {
        throw new Error("unreachable");
      },
    };
    const clock = new FakeClock();
    const { c } = start({ connector: failing, clock, random: () => 0.999999 });
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      await waitFor(() => c.snapshot().state === "backoff");
      const next = c.snapshot().nextRetryAt ?? 0;
      delays.push(Math.round((next - clock.now()) / 1000));
      expect(c.snapshot().lastError).toContain("cannot resolve");
      clock.advance(next - clock.now());
    }
    expect(delays.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 32, 60]);
    clock.advance(60 * 60_000 - 1);
    await waitFor(() => c.snapshot().state === "backoff" && (c.snapshot().nextRetryAt ?? 0) > clock.now());
    clock.advance((c.snapshot().nextRetryAt ?? 0) - clock.now());
    await waitFor(() => c.snapshot().state === "backoff" && (c.snapshot().nextRetryAt ?? 0) > clock.now());
    expect((c.snapshot().nextRetryAt ?? 0) - clock.now()).toBeGreaterThan(BACKOFF_CAP_MS);
    expect((c.snapshot().nextRetryAt ?? 0) - clock.now()).toBeLessThanOrEqual(BACKOFF_LONG_CAP_MS);
  });

  it("treats a close after auth as a refused ticket and a revoke notice as final", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    r.relay.authMode = "close";
    const clock = new FakeClock();
    const { c } = start({ clock });
    await waitFor(() => c.snapshot().state === "backoff");
    expect(c.snapshot().lastError).toBe("relay refused authentication");

    r.relay.authMode = "revoke";
    clock.advance((c.snapshot().nextRetryAt ?? 0) - clock.now());
    await waitFor(() => c.snapshot().state === "rejected");
    expect(c.snapshot().lastError).toMatch(/^revoked/);
    const lookups = r.relay.lookups;
    clock.advance(24 * 60 * 60_000);
    expect(r.relay.lookups).toBe(lookups);
    expect(c.snapshot().state).toBe("rejected");
  });

  it("stops for good when superseded by another computer", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    const { c } = start();
    await waitFor(() => relay.idleCount(label) === 3);
    r.relay.send(label, { type: "notice", code: "superseded" });
    await waitFor(() => c.snapshot().state === "rejected");
    expect(c.snapshot().lastError).toMatch(/^superseded/);
  });

  it("reconnects quickly after a draining notice", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    const { c, clock } = start({ random: () => 0 });
    await waitFor(() => c.snapshot().state === "connected");
    r.relay.send(label, { type: "notice", code: "draining" });
    await waitFor(() => c.snapshot().state === "backoff");
    const wait = (c.snapshot().nextRetryAt ?? 0) - clock.now();
    expect(wait).toBeGreaterThanOrEqual(DRAIN_MIN_MS);
    expect(wait).toBeLessThanOrEqual(DRAIN_MAX_MS);
    clock.advance(wait);
    await waitFor(() => relay.count("control:ready") === 2);
  });

  it("pings, measures RTT and gives up on a silent relay", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    const { c, clock } = start();
    await waitFor(() => c.snapshot().state === "connected");
    clock.advance(HEARTBEAT_MS);
    await waitFor(() => relay.count("ping") === 1);
    await waitFor(() => c.snapshot().rttMs !== null);
    expect(c.snapshot().rttMs).toBe(0);

    r.relay.answerPings = false;
    clock.advance(HEARTBEAT_MS);
    await waitFor(() => relay.count("ping") === 2);
    clock.advance(HEARTBEAT_MS);
    await waitFor(() => relay.count("ping") === 3);
    clock.advance(HEARTBEAT_MS);
    await waitFor(() => c.snapshot().state === "backoff");
    expect(c.snapshot().lastError).toBe("relay stopped answering heartbeats");
  });

  it("reconnects at once after a sleep gap instead of waiting out backoff", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    const { c, clock } = start();
    await waitFor(() => c.snapshot().state === "connected");
    clock.jump(5 * 60_000);
    clock.advance(TICK_MS);
    await waitFor(() => relay.count("control:ready") === 2);
    expect(r.relay.count("control:open")).toBe(2);
  });

  it("ignores a late DNS answer from a replaced attempt", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    const answers: Array<Deferred<string>> = [];
    const connects: string[] = [];
    const base = r.relay.connector();
    const connector: RelayConnector = {
      lookup: () => {
        const d = deferred<string>();
        answers.push(d);
        return d.promise;
      },
      connect: (address, servername, alpn) => {
        connects.push(`${alpn}@${address}`);
        return base.connect(address, servername, alpn);
      },
    };
    const { c, clock } = start({ connector });
    expect(answers).toHaveLength(1);
    clock.jump(5 * 60_000);
    clock.advance(TICK_MS);
    expect(answers).toHaveLength(2);
    answers[1].resolve("10.9.9.2");
    await waitFor(() => c.snapshot().state === "connected");
    answers[0].resolve("10.9.9.1");
    await Promise.resolve();
    expect(connects).toEqual(["wink-ctl/1@10.9.9.2"]);
    expect(c.snapshot().state).toBe("connected");

    // stop() while data channel lookups are pending: they never connect.
    await waitFor(() => answers.length === 5);
    c.stop();
    for (const answer of answers.slice(2)) answer.resolve("10.9.9.3");
    await Promise.resolve();
    await Promise.resolve();
    expect(connects).toEqual(["wink-ctl/1@10.9.9.2"]);
    expect(clock.pending).toBe(0);
  });

  it("stop() is idempotent, closes everything and silences callbacks", async () => {
    r = await rig();
    const relay = r.relay;
    const label = r.identity.label;
    relay.on("event", () => bus.emit("event"));
    const { c, clock, changes } = start();
    await waitFor(() => relay.idleCount(label) === 3);
    c.stop();
    const after = changes();
    c.stop();
    await waitFor(() => !relay.hasControl(label) && relay.idleCount(label) === 0);
    clock.advance(24 * 60 * 60_000);
    expect(changes()).toBe(after);
    expect(c.snapshot().state).toBe("stopped");
    expect(clock.pending).toBe(0);
  });

  it("stores a refreshed ticket from ready and uses it next time", async () => {
    r = await rig();
    const relay = r.relay;
    relay.on("event", () => bus.emit("event"));
    const fresh = r.relay.ticketFor(r.identity.pk, 2 * 365 * 24 * 3600);
    r.relay.refreshTicket = fresh;
    const { tickets } = start();
    await waitFor(() => relay.count("control:ready") === 1);
    await waitFor(() => tickets.length === 1);
    expect(tickets).toEqual([fresh]);
  });
});

/** Client changes, go callbacks and relay events all land here. */
const bus = new EventEmitter();
bus.setMaxListeners(100);

/** Resolves once `check` holds, re-checking on every client or relay event. */
function waitFor(check: () => boolean): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (!check()) return;
      bus.off("event", listener);
      resolve();
    };
    bus.on("event", listener);
  });
}
