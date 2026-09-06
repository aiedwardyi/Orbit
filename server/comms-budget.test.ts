// One turn's ask_bot budget. create_bot and delegate_bot are both capped;
// ask_bot was not, and each ask is a full turn on another bot at its own
// model with a four-minute ceiling.
import { beforeEach, describe, expect, it } from "vitest";

import { claimAsk, clearAskBudget, MAX_ASKS_PER_TURN } from "./comms-budget.ts";

describe("claimAsk", () => {
  beforeEach(() => {
    clearAskBudget("thread-a");
    clearAskBudget("thread-b");
  });

  it("allows one turn's worth of asks and then refuses", () => {
    for (let i = 0; i < MAX_ASKS_PER_TURN; i++) expect(claimAsk("thread-a")).toBe(true);
    expect(claimAsk("thread-a")).toBe(false);
    expect(claimAsk("thread-a")).toBe(false);
  });

  it("budgets each source thread on its own", () => {
    for (let i = 0; i < MAX_ASKS_PER_TURN; i++) claimAsk("thread-a");
    expect(claimAsk("thread-b")).toBe(true);
  });

  it("gives the budget back when the turn settles", () => {
    for (let i = 0; i < MAX_ASKS_PER_TURN; i++) claimAsk("thread-a");
    expect(claimAsk("thread-a")).toBe(false);

    clearAskBudget("thread-a");

    expect(claimAsk("thread-a")).toBe(true);
  });
});
