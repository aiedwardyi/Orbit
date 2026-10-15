import { describe, expect, it } from "vitest";

import { steersSend } from "./send-deliver.ts";

const steering = { capabilities: { queueing: true }, steer: async () => true };

describe("steersSend", () => {
  it("steers a busy steering engine as before", () => {
    expect(steersSend(steering, true, false)).toBe(true);
  });

  it("leaves an after-this-turn send to the queue", () => {
    expect(steersSend(steering, true, true)).toBe(false);
  });

  it("never steers an idle bot", () => {
    expect(steersSend(steering, false, false)).toBe(false);
  });

  it("never steers an engine that cannot", () => {
    expect(steersSend({ capabilities: { queueing: false }, steer: steering.steer }, true, false)).toBe(false);
    expect(steersSend({ capabilities: { queueing: true } }, true, false)).toBe(false);
    expect(steersSend(undefined, true, false)).toBe(false);
  });
});
