// Limits and token-bucket rate limiting (design section 9).

export interface RelayLimits {
  /** Incomplete ClientHello: bytes are capped by the shared parser, time here. */
  handshakeTimeoutMs: number;
  /** Open TCP connections in total (each PC holds 1 control + its pool). */
  maxConnections: number;
  /** Concurrent sockets that have not yet sent a full ClientHello. */
  maxPendingHandshakes: number;
  /** Outer TLS handshake on relay.<base>. */
  tlsHandshakeTimeoutMs: number;
  /** New TCP connections per source IP (IPv6 /64). */
  connPerIpPerSec: number;
  connPerIpBurst: number;
  /** Control channel auth attempts per source IP. */
  controlAuthPerIpPerMin: number;
  enrollPerIpPerHour: number;
  statusPerIpPerMin: number;
  /** PC must send `auth` (control) or `join` (data) within this. */
  authTimeoutMs: number;
  joinTimeoutMs: number;
  pingIntervalMs: number;
  /** Spliced phone connections per label. */
  maxSplicedPerLabel: number;
  /** Parked data channels per label. */
  maxIdlePerLabel: number;
  /** Phones waiting on an empty pool, per label and in total. */
  maxWaitingPerLabel: number;
  maxWaitingTotal: number;
  phoneWaitMs: number;
  /** Idle timeout of a spliced pair. SSE heartbeats every 15 s keep chat streams alive. */
  spliceIdleMs: number;
  /** Live control sessions in total. */
  maxSessions: number;
  /** Labels remembered for /v1/status `since`. */
  maxStatusEntries: number;
  /** Request body of POST /v1/enroll. */
  maxBodyBytes: number;
  /** On shutdown, spliced connections get this long before they are cut. */
  drainGraceMs: number;
}

export const DEFAULT_LIMITS: Readonly<RelayLimits> = Object.freeze({
  handshakeTimeoutMs: 5_000,
  maxConnections: 200_000,
  maxPendingHandshakes: 4_096,
  tlsHandshakeTimeoutMs: 10_000,
  connPerIpPerSec: 20,
  connPerIpBurst: 60,
  controlAuthPerIpPerMin: 6,
  enrollPerIpPerHour: 5,
  statusPerIpPerMin: 60,
  authTimeoutMs: 10_000,
  joinTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  maxSplicedPerLabel: 256,
  maxIdlePerLabel: 16,
  maxWaitingPerLabel: 32,
  maxWaitingTotal: 4_096,
  phoneWaitMs: 5_000,
  spliceIdleMs: 10 * 60_000,
  maxSessions: 50_000,
  maxStatusEntries: 100_000,
  maxBodyBytes: 4_096,
  drainGraceMs: 10_000,
});

interface Bucket {
  tokens: number;
  at: number;
}

/** Token bucket per key. The key map is bounded; the oldest key is evicted first. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(ratePerSec: number, burst: number, now: () => number = Date.now, maxKeys = 65_536) {
    this.ratePerMs = ratePerSec / 1000;
    this.burst = burst;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  static perMinute(n: number, now?: () => number): RateLimiter {
    return new RateLimiter(n / 60, n, now);
  }

  static perHour(n: number, now?: () => number): RateLimiter {
    return new RateLimiter(n / 3600, n, now);
  }

  take(key: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key);
      bucket.tokens = Math.min(this.burst, bucket.tokens + (t - bucket.at) * this.ratePerMs);
      bucket.at = t;
    } else {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      bucket = { tokens: this.burst, at: t };
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
