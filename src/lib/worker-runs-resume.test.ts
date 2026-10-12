import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { listedRuns, workerRuns } from "./worker-runs";

const pane = "5d09c0d0-2844-43b0-982e-88305df70570";
const label = "A | Opus 5.5 | high";
const launch = (id: string, at: number): Message => ({
  id, at, role: "bot", kind: "launch",
  text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${pane}`,
});
const done = (id: string, at: number): Message => ({
  id, at, role: "bot", kind: "note",
  text: `[pane ${pane.slice(0, 8)}] [${label}] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): DONE A branch=x sha=y dirty=no\nFinished`,
});
const resume = (id: string, at: number, submitted: number): Message => ({
  id, at, role: "bot", kind: "launch",
  text: `Resumed ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${pane}\nSubmitted: ${submitted}`,
});

function shown(messages: Message[]) {
  const listed = listedRuns(workerRuns(messages).map((run) => ({ run, state: run.state })), new Set([pane]));
  return listed[0]?.state;
}

describe("late resume note", () => {
  it("stays done when the follow-up reports before the resume row is stored", () => {
    expect(shown([launch("launch", 1), done("old", 2), done("follow-up", 4), resume("late", 5, 3)])).toBe("done");
  });

  it("stays done when the resume row is stored before the follow-up report", () => {
    expect(shown([launch("launch", 1), done("old", 2), resume("late", 5, 3), done("follow-up", 4)])).toBe("done");
  });

  it("shows working when the report is from before the submission", () => {
    expect(shown([launch("launch", 1), done("old", 2), resume("follow-up", 4, 3)])).toBe("working");
  });

  it("shows working for a later follow-up after that report settled", () => {
    expect(shown([
      launch("launch", 1),
      done("old", 2),
      resume("first", 4, 3),
      done("follow-up", 5),
      resume("second", 7, 6),
    ])).toBe("working");
  });
});
