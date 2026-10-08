import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AskUserRecord } from "./AskUserRecord";
import { isOnboardingCard } from "./OptionCard";
import type { Message } from "@/state/store";

const ask = (id: string, card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id,
  role: "bot",
  kind: "options",
  at: 1,
  card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true, ...card },
});
const render = (message: Message, transcript: Message[]) =>
  renderToStaticMarkup(createElement(AskUserRecord, { message, transcript, askerName: "Ada" }));

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

  it("is never mistaken for the first-run quiz", () => {
    expect(isOnboardingCard(ask("q1"))).toBe(false);
    expect(isOnboardingCard({ ...ask("quiz"), card: { title: "Quiz", subtitle: "", options: ["Work"] } })).toBe(true);
  });
});
