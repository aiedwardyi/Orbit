// Injectable time source for the relay client, ingress and ACME loop, so
// tests drive backoff, heartbeats and sleep gaps without real waiting.

export type Cancel = () => void;

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule(ms: number, fn: () => void): Cancel;
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** Resolves after `ms`. Registers a canceller in `cancels` that rejects with CancelledError. */
export function sleep(clock: Clock, ms: number, cancels: Set<Cancel>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      stopTimer();
      cancels.delete(cancel);
      reject(new CancelledError());
    };
    const stopTimer = clock.schedule(ms, () => {
      cancels.delete(cancel);
      resolve();
    });
    cancels.add(cancel);
  });
}
