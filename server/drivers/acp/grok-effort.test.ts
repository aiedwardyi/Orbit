import { describe, expect, it } from "vitest";

import type { AcpConfig } from "./core.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { configOptionValue, findGrokEffortConfigId, grokSupport } from "./grok.ts";

const config = { cli: "grok", fullAuto: false } satisfies AcpConfig;
const turn = (overrides: Partial<SendTurnInput> = {}): SendTurnInput => ({
  threadId: "thread-1",
  text: "hello",
  model: "grok-4.6",
  ...overrides,
});

const sessionResultWith = (id: string) => ({
  configOptions: [
    { id, name: "Reasoning effort", currentValue: "high" },
    { id: "other-setting", currentValue: "on" },
  ],
});

describe("grok reasoning-effort discovery", () => {
  it.each(["reasoning_effort", "reasoningEffort", "reasoning-effort"])("finds the effort option spelled %s", (id) => {
    expect(findGrokEffortConfigId(sessionResultWith(id))).toBe(id);
  });

  it("prefers the effort option over looser matches", () => {
    expect(findGrokEffortConfigId({
      configOptions: [{ id: "effort" }, { id: "reasoning_effort" }],
    })).toBe("reasoning_effort");
  });

  it("returns null when nothing advertises effort", () => {
    expect(findGrokEffortConfigId({ configOptions: [{ id: "model" }] })).toBeNull();
    expect(findGrokEffortConfigId({})).toBeNull();
    expect(findGrokEffortConfigId(null)).toBeNull();
  });

  it("reads currentValue out of a set_config_option result", () => {
    expect(configOptionValue({ configOptions: [{ id: "reasoning_effort", currentValue: "xhigh" }] }, "reasoning_effort")).toBe("xhigh");
    expect(configOptionValue({ configOptions: [] }, "reasoning_effort")).toBeNull();
    expect(configOptionValue({}, "reasoning_effort")).toBeNull();
  });
});

describe("grok configureSession effort pin", () => {
  it("sets the model before the effort over the wire", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "session/set_model") return {};
      if (method === "session/set_config_option") {
        const value = (params as { value: unknown }).value;
        return { configOptions: [{ id: "reasoning_effort", currentValue: value }] };
      }
      throw new Error(`unexpected ${method}`);
    };
    await grokSupport.configureSession!({
      request, sessionId: "session-1", config, turn: turn({ effort: "xhigh" }), sessionModels: [],
      sessionResult: sessionResultWith("reasoning_effort"),
    });
    expect(calls.map((call) => call.method)).toEqual(["session/set_model", "session/set_config_option"]);
    expect(calls[1]!.params).toMatchObject({ sessionId: "session-1", configId: "reasoning_effort", value: "xhigh" });
  });

  it("skips the wire entirely when no effort is requested", async () => {
    let calls = 0;
    await grokSupport.configureSession!({
      request: async () => {
        calls++;
        return {};
      },
      sessionId: "session-1", config, turn: turn(), sessionModels: [],
      sessionResult: sessionResultWith("reasoning_effort"),
    });
    expect(calls).toBe(1);
  });

  it("fails the turn when no effort option is advertised", async () => {
    await expect(grokSupport.configureSession!({
      request: async () => ({}),
      sessionId: "session-1", config, turn: turn({ effort: "xhigh" }), sessionModels: [],
      sessionResult: { configOptions: [] },
    })).rejects.toThrow(/no reasoning-effort setting/i);
  });

  it("fails the turn when the effort does not stick", async () => {
    const request = async (method: string) => {
      if (method === "session/set_model") return {};
      return { configOptions: [{ id: "reasoning_effort", currentValue: "high" }] };
    };
    await expect(grokSupport.configureSession!({
      request, sessionId: "session-1", config, turn: turn({ effort: "xhigh" }), sessionModels: [],
      sessionResult: sessionResultWith("reasoning_effort"),
    })).rejects.toThrow(/did not switch reasoning effort/i);
  });

  it("fails the turn when the setter rejects", async () => {
    const request = async (method: string) => {
      if (method === "session/set_model") return {};
      throw new Error("method not found");
    };
    await expect(grokSupport.configureSession!({
      request, sessionId: "session-1", config, turn: turn({ effort: "xhigh" }), sessionModels: [],
      sessionResult: sessionResultWith("reasoning_effort"),
    })).rejects.toThrow(/rejected reasoning effort/i);
  });
});
