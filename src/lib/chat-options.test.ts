import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatOptionChoices, detectChatOptions, laterUserAnswer } from "./chat-options";

describe("chatOptionChoices", () => {
  it("reads a trailing lettered list after a question", () => {
    expect(
      chatOptionChoices("Which package manager?\n\nA) pnpm\nB) npm"),
    ).toEqual(["pnpm", "npm"]);
  });

  it("reads numbered and bullet lists after a question", () => {
    expect(chatOptionChoices("Pick a lane?\n\n1. Work\n2. Personal")).toEqual(["Work", "Personal"]);
    expect(chatOptionChoices("Which one?\n- pnpm\n- npm\n- bun")).toEqual(["pnpm", "npm", "bun"]);
  });

  it("ignores a bulleted list that is not a question", () => {
    expect(
      chatOptionChoices("Here's the plan:\n- fix the tests\n- ship the build\n- write the docs"),
    ).toBeNull();
  });

  it("ignores a question with no options", () => {
    expect(chatOptionChoices("What should I do next?")).toBeNull();
  });

  it("ignores lists inside code fences", () => {
    expect(
      chatOptionChoices("See this?\n```\n- not a choice\n- also not\n```"),
    ).toBeNull();
  });

  it("ignores a list that is not at the end", () => {
    expect(
      chatOptionChoices("Which one?\n- pnpm\n- npm\n\nI can also just pick."),
    ).toBeNull();
  });

  it("ignores more than five trailing options", () => {
    expect(
      chatOptionChoices("Which letter?\n- a\n- b\n- c\n- d\n- e\n- f"),
    ).toBeNull();
  });

  it("ignores a single trailing bullet", () => {
    expect(chatOptionChoices("One idea?\n- only this")).toBeNull();
  });
});

describe("detectChatOptions", () => {
  it("exposes the trailing question and strips it from the bubble prefix", () => {
    const detected = detectChatOptions(
      "The cleanup already runs safely.\n\nHow should the app close?\n\nA) Finish the current task, then close\nB) Close immediately\nC) Ask me each time",
    );
    expect(detected).toEqual({
      options: ["Finish the current task, then close", "Close immediately", "Ask me each time"],
      question: "How should the app close?",
      messagePrefix: "The cleanup already runs safely.",
    });
  });

  it("ignores formatted prose that resembles a choice card", () => {
    expect(
      detectChatOptions(
        '- **Your turn**: Try running `"PyThOn".lower()` in your head or in python - what does it become?',
      ),
    ).toBeNull();
  });

  it("reads a short bullet list after an explicit question", () => {
    expect(detectChatOptions("Which one?\n- Red\n- Blue")).toEqual({
      options: ["Red", "Blue"],
      question: "Which one?",
      messagePrefix: "",
    });
  });

  it("rejects formatted list items", () => {
    expect(detectChatOptions("Pick:\n- **Bold** item\n- other")).toBeNull();
  });

  it("does not split an ordinary or question", () => {
    expect(detectChatOptions("Do you want tea or coffee?")).toBeNull();
  });
});

describe("laterUserAnswer", () => {
  it("returns the next user text after a bot question", () => {
    expect(
      laterUserAnswer(
        [
          { id: "b1", role: "bot", kind: "text", text: "Pick?\n- a\n- b" },
          { id: "u1", role: "user", kind: "text", text: "a" },
        ],
        "b1",
      ),
    ).toBe("a");
  });

  it("returns null when nobody has answered yet", () => {
    expect(laterUserAnswer([{ id: "b1", role: "bot", kind: "text", text: "Pick?" }], "b1")).toBeNull();
  });
});

describe("chat option chips wiring", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const chatView = readFileSync(join(dir, "../components/ChatView.tsx"), "utf8");
  const groupView = readFileSync(join(dir, "../components/GroupView.tsx"), "utf8");

  it("renders chips from detectChatOptions on 1:1 and room bubbles", () => {
    expect(chatView).toContain("detectChatOptions");
    expect(chatView).toContain("ChatOptionChips");
    expect(groupView).toContain("detectChatOptions");
    expect(groupView).toContain("ChatOptionChips");
  });

  it("offers write-own via the composer, not an inline chip input", () => {
    const chips = readFileSync(join(dir, "../components/ChatOptionChips.tsx"), "utf8");
    expect(chips).toContain("focusOrbitComposer");
    expect(chips).toContain("QuestionChoiceCard");
    expect(chips).not.toContain("sendCustom");
    expect(chatView).toContain("composerRef={composerInputRef}");
    expect(chatView).toContain("onFocusComposer={focusComposer}");
    expect(groupView).toContain("composerRef={composerInputRef}");
    expect(groupView).toContain("onFocusComposer={focusComposer}");
  });
});
