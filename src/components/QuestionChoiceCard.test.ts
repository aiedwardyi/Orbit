import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QuestionChoiceCard } from "./QuestionChoiceCard";
import { applyLocale } from "@/lib/i18n";

describe("QuestionChoiceCard", () => {
  it("renders the compact choice layout with A/B markers and write-own", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      createElement(QuestionChoiceCard, {
        question: "How should the app close?",
        options: ["Finish the current task, then close", "Ask me each time"],
        onPick: () => {},
        onWriteOwn: () => {},
      }),
    );
    expect(html).toContain("orbit-question-card");
    expect(html).toContain("Your choice");
    expect(html).toContain("How should the app close?");
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain("Write my own answer");
    expect(html).toContain("Click a choice to reply");
    expect(html).toContain("max-w-[560px]");
    expect(html).not.toContain("rounded-full border"); // pill chips; signal dot may be rounded-full
  });

  it("shows Answer sent and locks rows when a listed choice was picked", () => {
    applyLocale("en");
    const onPick = vi.fn();
    const html = renderToStaticMarkup(
      createElement(QuestionChoiceCard, {
        question: "Pick?",
        options: ["one", "two"],
        selectedOption: "one",
        onPick,
      }),
    );
    expect(html).toContain("Answered");
    expect(html).toContain("Answer sent");
    expect(html).toContain("data-answered=\"true\"");
    expect(html).toMatch(/disabled/);
  });

  it("custom answers show receipt without selecting a row", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      createElement(QuestionChoiceCard, {
        options: ["one", "two"],
        customAnswered: true,
        onPick: () => {},
      }),
    );
    expect(html).toContain("Answer sent");
    expect(html).not.toContain("border-accent-text");
  });
});
