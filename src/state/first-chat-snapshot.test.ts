import { describe, expect, it, vi } from "vitest";

import {
  DEFERRED_INSTANCE_IDLE_MS,
  firstChatPeripherals,
  isFirstChatPeripheral,
  scheduleDeferredInstancesLoad,
} from "./first-chat-snapshot";

describe("first chat snapshot keeps engine describe off the composer path", () => {
  it("loads config, routines, and webhooks with chat — not instances", () => {
    expect(firstChatPeripherals([
      { key: "instances" },
      { key: "config" },
      { key: "routines" },
      { key: "webhooks" },
    ]).map((part) => part.key)).toEqual(["config", "routines", "webhooks"]);
    expect(isFirstChatPeripheral("instances")).toBe(false);
    expect(isFirstChatPeripheral("config")).toBe(true);
  });

  it("wakes the instances scan on idle instead of the first snapshot", () => {
    const wake = vi.fn();
    const cancel = vi.fn();
    const idle = {
      requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => {
        expect(opts?.timeout).toBe(DEFERRED_INSTANCE_IDLE_MS);
        cb();
        return 7;
      },
      cancelIdleCallback: cancel,
    };
    const stop = scheduleDeferredInstancesLoad(wake, idle);
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
