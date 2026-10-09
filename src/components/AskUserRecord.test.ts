import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AskUserRecord } from "./AskUserRecord";
import { isOnboardingCard } from "./OptionCard";
import { pinnedQuestion } from "@/lib/open-question";
import type { Message } from "@/state/store";

const ask = (id: string, card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id,
  role: "bot",
  kind: "options",
  at: 1,
  card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true, ...card },
});
const render = (message: Message, transcript: Message[], pinned?: boolean) =>
  renderToStaticMarkup(createElement(AskUserRecord, { message, transcript, askerName: "Ada", pinned }));

describe("AskUserRecord", () => {
  it("records the question without inline choices while it waits", () => {
    const question = ask("q1");
    const markup = render(question, [question]);
    expect(markup).toContain("Ada asks");
    expect(markup).toContain("Prod or staging?");
    expect(markup).toContain("Waiting for your answer below");
    expect(markup).not.toContain("<button");
  });

  it("shows the first line of the reply, a dismissal, or a newer question", () => {
    const question = ask("q1");
    const reply: Message = { id: "u1", role: "user", kind: "text", at: 2, text: "Staging\nbecause the data is fresher" };
    expect(render(question, [question, reply])).toContain("Answered: Staging<");
    const dismissed = ask("q1", { dismissed: true });
    expect(render(dismissed, [dismissed])).toContain("Dismissed");
    expect(render(question, [question, ask("q2")])).toContain("Superseded by a newer question");
  });

  it("shrinks to one line while the composer pins the question", () => {
    const question = ask("q1");
    const markup = render(question, [question], true);
    expect(markup).toContain("Ada is waiting for your answer below");
    expect(markup).not.toContain("Ada asks");
    expect(markup).not.toContain("Prod or staging?");
  });

  it("keeps the full record once settled, even if still flagged pinned", () => {
    const question = ask("q1");
    const reply: Message = { id: "u1", role: "user", kind: "text", at: 2, text: "Staging" };
    expect(render(question, [question, reply], true)).toContain("Prod or staging?");
    const dismissed = ask("q1", { dismissed: true });
    expect(render(dismissed, [dismissed], true)).toContain("Prod or staging?");
  });

  it("keeps the full record when an approval hides the pin", () => {
    const question = ask("q1");
    const approval: Message = {
      id: "approval-1",
      role: "bot",
      kind: "options",
      at: 2,
      card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
    };
    const transcript = [question, approval];
    const markup = render(question, transcript, pinnedQuestion(transcript)?.id === question.id);
    expect(markup).toContain("Ada asks");
    expect(markup).toContain("Prod or staging?");
  });

  it("is never mistaken for the first-run quiz", () => {
    expect(isOnboardingCard(ask("q1"))).toBe(false);
    expect(isOnboardingCard({ ...ask("quiz"), card: { title: "Quiz", subtitle: "", options: ["Work"] } })).toBe(true);
  });
});
