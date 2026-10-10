import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import { applyPendingModel, modelPickPatch, type PendingModelBot } from "./pending-model.ts";

const running: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", mode: "pinned", effort: "high" };
const next: ModelSelection = { instanceId: "codex", model: "gpt-6-sol", mode: "pinned" };

describe("pending model", () => {
  it("holds a pick made while busy and keeps the running selection", () => {
    const bot: PendingModelBot = { modelSelection: running, busy: true };
    expect(modelPickPatch(bot, next)).toEqual({ pendingModelSelection: next });
  });

  it("clears the held pick when the running selection is chosen again", () => {
    const bot: PendingModelBot = { modelSelection: running, pendingModelSelection: next, busy: true };
    const patch = modelPickPatch(bot, { ...running, mode: undefined });
    expect(patch).toEqual({ pendingModelSelection: undefined });
    expect(patch).not.toHaveProperty("modelSelection");
  });

  it("applies a pick on an idle bot at once and drops any held one", () => {
    const bot: PendingModelBot = { modelSelection: running, pendingModelSelection: next, busy: false };
    expect(modelPickPatch(bot, next)).toEqual({ modelSelection: next, pendingModelSelection: undefined });
  });

  it("applies the held pick when the turn ends", () => {
    const bot: PendingModelBot = { modelSelection: running, pendingModelSelection: next, busy: true };
    expect(applyPendingModel(bot)).toBe(false);
    expect(bot.modelSelection).toBe(running);
    bot.busy = false;
    expect(applyPendingModel(bot)).toBe(true);
    expect(bot).toEqual({ modelSelection: next, busy: false });
    expect(applyPendingModel(bot)).toBe(false);
  });
});
