// Manual clock for relay tests. advance() fires due timers in order;
// jump() moves time without firing anything, like an OS sleep.

import type { Cancel, Clock } from "../clock.ts";

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = Date.now()) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  schedule(ms: number, fn: () => void): Cancel {
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Time of the earliest pending timer, if any. */
  get nextAt(): number | null {
    let best: number | null = null;
    for (const timer of this.timers) if (best === null || timer.at < best) best = timer.at;
    return best;
  }

  /** Fires every timer due within `ms`, including ones scheduled meanwhile. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }

  /** Moves time forward without firing timers. */
  jump(ms: number): void {
    this.t += ms;
  }
}
