import { describe, expect, it } from "vitest";

import { pendingApprovals } from "./PendingApproval";
import type { Message } from "@/state/store";

const quiz: Message = {
  id: "q",
  role: "bot",
  kind: "options",
  at: 1,
  card: {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects", "Writing & research"],
  },
};

const approval: Message = {
  id: "ask",
  role: "bot",
  kind: "options",
  at: 2,
  card: {
    title: "Approval needed",
    subtitle: "rm",
    options: ["Allow", "Deny"],
    requestId: "r1",
    tool: "Bash",
  },
};

describe("pendingApprovals first-turn ignore", () => {
  it("does not treat the first-turn quiz as a composer approval", () => {
    expect(pendingApprovals([quiz])).toEqual([]);
  });

  it("stays empty after the first-turn quiz is ignored", () => {
    expect(pendingApprovals([{ ...quiz, card: { ...quiz.card!, dismissed: true } }])).toEqual([]);
  });

  it("drops a live approval once it is dismissed", () => {
    expect(pendingApprovals([approval])).toHaveLength(1);
    expect(pendingApprovals([{ ...approval, card: { ...approval.card!, dismissed: true } }])).toEqual([]);
  });
});
