import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { applyLocale } from "@/lib/i18n";
import { StoreProvider, type Message } from "@/state/store";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind">): Message => ({
  role: "bot",
  at: 1,
  ...partial,
});

describe("shouldHideOnboardingCard", () => {
  const quiz = msg({
    id: "quiz",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects"],
    },
  });
  const greeting = msg({ id: "hi", kind: "text", text: "Hey — I'm Echo." });
  const user = msg({ id: "u1", role: "user", kind: "text", text: "Hi bro" });

  it("keeps the quiz until the person talks", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz])).toBe(false);
  });

  it("hides once a later user message is on the path", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz, user])).toBe(true);
  });

  it("hides an answered or dismissed quiz even with no later user message", () => {
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, answered: "Work & projects" } }, [greeting, quiz]),
    ).toBe(true);
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, dismissed: true } }, [greeting, quiz]),
    ).toBe(true);
  });

  it("never hides a live permission or question card", () => {
    const ask = msg({
      id: "ask",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    expect(shouldHideOnboardingCard(ask, [greeting, quiz, user, ask])).toBe(false);
    const question = msg({
      id: "q",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: "which file?",
        options: [],
        requestId: "req-2",
      },
    });
    expect(shouldHideOnboardingCard(question, [user, question])).toBe(false);
  });
});

describe("OptionCard language", () => {
  const firstQuestion = msg({
    id: "first",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
    },
  });
  const render = (message: Message, locale: "en" | "ko") => {
    const { document } = new Window();
    applyLocale(locale);
    try {
      document.body.innerHTML = renderToStaticMarkup(createElement(StoreProvider, null, createElement(OptionCard, { botId: "bot", message })));
    } finally {
      applyLocale("en");
    }
    return {
      text: document.body.textContent,
      dismiss: document.querySelector("button[aria-label]")?.getAttribute("aria-label"),
      placeholder: document.querySelector("input")?.getAttribute("placeholder"),
    };
  };

  it.each([
    ["en", "What do you mostly want help with?", "Pick whatever's closest; we can always expand from there.", ["Work & projects", "Writing & research", "Life admin", "A bit of everything"], "Dismiss question", "Type your own answer"],
    ["ko", "주로 어떤 일에 도움이 필요하세요?", "가장 가까운 것을 고르세요. 나중에 언제든 넓힐 수 있습니다.", ["업무와 프로젝트", "글쓰기와 리서치", "생활 관리", "이것저것 조금씩"], "질문 닫기", "답을 직접 입력하세요"],
  ] as const)("renders the first question card in %s", (locale, title, subtitle, options, dismiss, placeholder) => {
    expect(render(firstQuestion, locale)).toEqual({
      text: `${title}${subtitle}${options.map((option, i) => "ABCD"[i] + option).join("")}`,
      dismiss,
      placeholder,
    });
  });

  it("keeps a live question's own text in Korean", () => {
    const question = msg({
      id: "q",
      kind: "options",
      card: { title: "Your bot has a question", subtitle: "which file?", options: ["a.ts", "b.ts"], requestId: "req-2" },
    });
    expect(render(question, "ko").text).toBe("Your bot has a questionwhich file?Aa.tsBb.ts");
  });
});
