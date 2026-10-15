import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";

function message(
  status: RoutineRunCardData["status"],
  patch: Partial<RoutineRunCardData> = {},
): Message {
  return {
    id: "routine-run-card",
    role: "bot",
    kind: "routine.run",
    at: 1,
    text: "Morning brief routine update",
    routineRun: {
      runId: "run-1",
      routineId: "routine-1",
      routineName: "Morning brief",
      status,
      executionThreadId: "execution-thread",
      ...patch,
    },
  };
}

const at = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes).getTime();

describe("RoutineRunCard", () => {
  it("shows name, time and the instruction in one line with no Open run", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("completed", {
        executionThreadId: undefined,
        runOn: "maus",
        scheduledFor: at(20, 0),
        instruction: "Start a 25-minute study session:\npick up from list comprehensions.",
        summary: "Study time! Last session we stopped at list comprehensions.",
      }),
      ringing: true,
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Morning brief");
    expect(markup).toContain(">20:00<");
    expect(markup).toMatch(/class="[^"]*\btruncate\b[^"]*">Start a 25-minute study session: pick up from list comprehensions\.<\/div>/);
    expect(markup).toContain("Rang at 20:00");
    expect(markup).toContain("border-accent/40");
    expect(markup).not.toContain("Study time!");
    expect(markup).not.toContain("Open run");
  });

  it("shows a compact completion receipt and a path to the isolated run", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("completed", { scheduledFor: at(8, 0), summary: "The brief is ready with three follow-ups." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Rang at 08:00");
    expect(markup).toContain("The brief is ready with three follow-ups.");
    expect(markup).toContain("Open run");
    expect(markup).toContain('aria-label="Morning brief: Rang at 08:00"');
  });

  it("settles a seen card to the answered look and keeps a failure visible", () => {
    const completed = renderToStaticMarkup(createElement(RoutineRunCard, { message: message("completed") }));
    expect(completed).toContain("border-hairline/30 opacity-70");
    expect(completed).not.toContain("border-accent/40");
    const failed = renderToStaticMarkup(createElement(RoutineRunCard, { message: message("failed", { error: "No engine" }) }));
    expect(failed.replace(/aria-label="[^"]*"/g, "")).toContain("Failed: No engine");
  });

  it("makes a waiting question or approval an explicit Review action", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("waiting", { summary: "The routine needs an answer before it can continue." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Needs a reply below");
    expect(markup).toContain("Review");
    expect(markup).toContain('aria-label="Review for Morning brief"');
  });

  it("shows a concise error without dumping a verbose run log into chat", () => {
    const verbose = `Provider failed ${"trace-line ".repeat(100)}`;
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("failed", { error: verbose }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Failed: Provider failed");
    expect(markup).toContain("…");
    expect(markup).not.toContain(verbose);
  });

  it("keeps a concise text fallback visible for an incomplete or newer payload", () => {
    const legacy: Message = {
      id: "legacy-run",
      role: "bot",
      kind: "routine.run",
      at: 1,
      text: "Morning brief completed.",
    };

    const markup = renderToStaticMarkup(createElement(RoutineRunCard, { message: legacy }));
    expect(markup).toContain("Morning brief completed.");
  });

  it("does not offer a dead navigation action when the execution task is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("missed", { executionThreadId: undefined, error: "Computer was offline." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Missed");
    expect(markup).not.toContain("Open run");
  });

  it("labels a running cloud routine as running", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("running", { runOn: "cloud", scheduledFor: at(8, 0), startedAt: at(8, 1) }),
    }));

    expect(markup).toContain("Running on Cloud VM");
    expect(markup).not.toContain("Rang at");
  });

  it("recognizes only an execution thread still present in the owning bot's tasks", () => {
    const tasks = [{ threadId: "source-thread" }, { threadId: "execution-thread" }];

    expect(hasRoutineExecutionTask(tasks, "execution-thread")).toBe(true);
    expect(hasRoutineExecutionTask(tasks, "deleted-thread")).toBe(false);
    expect(hasRoutineExecutionTask(undefined, "execution-thread")).toBe(false);
  });
});
